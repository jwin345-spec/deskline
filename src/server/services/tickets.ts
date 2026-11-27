import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TenantTx } from '../db/tenant';
import { NotFoundError, ValidationError } from '../domain/errors';
import { authorize, authorizeAssignment } from '../domain/rbac';
import { PRIORITIES, RESOLVED_STATUSES, TICKET_STATUSES, type TicketStatus } from '../domain/types';
import { listTicketAudit, recordAudit } from '../repositories/audit';
import { findMember, listMembers } from '../repositories/members';
import {
  findTicket,
  listMessages,
  listTickets,
  lockTicket,
  type TicketListFilters,
} from '../repositories/tickets';
import type { ServiceDeps } from './deps';
import { scheduleSla } from './sla-scheduling';

export const replyInput = z.object({
  ticketId: z.uuid(),
  body: z.string().trim().min(1, 'Write a message first').max(20_000),
  /** Status to move the ticket to after replying ("Send and set pending"). */
  statusAfter: z.enum(TICKET_STATUSES).optional(),
  /** True when the agent started from an AI draft; recorded for auditability. */
  aiAssisted: z.boolean().default(false),
});

export const noteInput = z.object({
  ticketId: z.uuid(),
  body: z.string().trim().min(1, 'Write a note first').max(20_000),
});

export const statusInput = z.object({ ticketId: z.uuid(), status: z.enum(TICKET_STATUSES) });
export const priorityInput = z.object({ ticketId: z.uuid(), priority: z.enum(PRIORITIES) });
export const assignInput = z.object({ ticketId: z.uuid(), assigneeId: z.uuid().nullable() });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
  }
  return result.data;
}

function actorUserId(tx: TenantTx): string | null {
  return tx.ctx.actor.kind === 'user' ? tx.ctx.actor.userId : null;
}

export async function getInbox(tx: TenantTx, filters: TicketListFilters) {
  authorize(tx.ctx.actor, 'ticket:read');
  return listTickets(tx, { ...filters, viewerId: actorUserId(tx) ?? undefined });
}

export async function getTicketView(tx: TenantTx, ticketId: string) {
  authorize(tx.ctx.actor, 'ticket:read');
  const ticket = await findTicket(tx, ticketId);
  if (!ticket) throw new NotFoundError('Ticket');
  // Sequential on purpose: a transaction is one connection, so there is nothing to parallelise.
  const messages = await listMessages(tx, ticket.id);
  const audit = await listTicketAudit(tx, ticket.id);
  const members = await listMembers(tx);
  const breaches = await tx.db
    .selectFrom('slaBreaches')
    .select(['kind', 'dueAt', 'breachedAt'])
    .where('workspaceId', '=', tx.workspaceId)
    .where('ticketId', '=', ticket.id)
    .execute();
  return { ticket, messages, audit, members, breaches };
}

async function requireLocked(tx: TenantTx, ticketId: string) {
  const ticket = await lockTicket(tx, ticketId);
  if (!ticket) throw new NotFoundError('Ticket');
  return ticket;
}

function statusPatch(from: TicketStatus, to: TicketStatus, now: Date) {
  const wasResolved = RESOLVED_STATUSES.includes(from);
  const isResolved = RESOLVED_STATUSES.includes(to);
  if (isResolved && !wasResolved) return { status: to, resolvedAt: now };
  if (!isResolved && wasResolved) return { status: to, resolvedAt: null };
  return { status: to };
}

/** Public reply from an agent. Never sent automatically; always an explicit agent action. */
export async function replyToTicket(tx: TenantTx, deps: ServiceDeps, raw: unknown) {
  const input = parse(replyInput, raw);
  authorize(tx.ctx.actor, 'ticket:reply');
  const ticket = await requireLocked(tx, input.ticketId);
  const now = deps.now();
  const emailMessageId = `<${randomUUID()}.${ticket.number}@deskline.local>`;

  const message = await tx.db
    .insertInto('messages')
    .values({
      workspaceId: tx.workspaceId,
      ticketId: ticket.id,
      authorType: 'agent',
      authorUserId: actorUserId(tx),
      body: input.body,
      internal: false,
      emailMessageId,
      createdAt: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const nextStatus = input.statusAfter ?? ticket.status;
  await tx.db
    .updateTable('tickets')
    .set({
      ...statusPatch(ticket.status, nextStatus, now),
      firstResponseAt: ticket.firstResponseAt ?? now,
      lastActivityAt: now,
      updatedAt: now,
    })
    .where('workspaceId', '=', tx.workspaceId)
    .where('id', '=', ticket.id)
    .execute();

  await recordAudit(tx, {
    at: now,
    ticketId: ticket.id,
    action: 'ticket.replied',
    data: { messageId: message.id, aiAssisted: input.aiAssisted },
  });
  if (!ticket.firstResponseAt) {
    await recordAudit(tx, {
      at: now,
      ticketId: ticket.id,
      action: 'sla.first_response',
      data: { seconds: Math.round((now.getTime() - ticket.createdAt.getTime()) / 1000) },
    });
  }
  if (nextStatus !== ticket.status) {
    await recordAudit(tx, {
      at: now,
      ticketId: ticket.id,
      action: 'ticket.status_changed',
      data: { from: ticket.status, to: nextStatus },
    });
  }

  tx.afterCommit(() => {
    deps.broker.publish(tx.workspaceId, {
      type: 'ticket.message',
      ticketId: ticket.id,
      number: ticket.number,
      internal: false,
      authorType: 'agent',
      actor: tx.ctx.actor.name,
      actorUserId: actorUserId(tx),
    });
  });
  return { messageId: message.id, emailMessageId };
}

/** Internal note: visible to agents only, excluded from search and from the customer. */
export async function addInternalNote(tx: TenantTx, deps: ServiceDeps, raw: unknown) {
  const input = parse(noteInput, raw);
  authorize(tx.ctx.actor, 'ticket:note');
  const ticket = await requireLocked(tx, input.ticketId);
  const now = deps.now();
  const message = await tx.db
    .insertInto('messages')
    .values({
      workspaceId: tx.workspaceId,
      ticketId: ticket.id,
      authorType: 'agent',
      authorUserId: actorUserId(tx),
      body: input.body,
      internal: true,
      createdAt: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx.db
    .updateTable('tickets')
    .set({ updatedAt: now })
    .where('workspaceId', '=', tx.workspaceId)
    .where('id', '=', ticket.id)
    .execute();
  await recordAudit(tx, {
    at: now,
    ticketId: ticket.id,
    action: 'ticket.note_added',
    data: { messageId: message.id },
  });
  tx.afterCommit(() => {
    deps.broker.publish(tx.workspaceId, {
      type: 'ticket.message',
      ticketId: ticket.id,
      number: ticket.number,
      internal: true,
      authorType: 'agent',
      actor: tx.ctx.actor.name,
      actorUserId: actorUserId(tx),
    });
  });
  return { messageId: message.id };
}

function publishUpdate(
  tx: TenantTx,
  deps: ServiceDeps,
  ticket: { id: string; number: number },
  changes: string[],
) {
  tx.afterCommit(() => {
    deps.broker.publish(tx.workspaceId, {
      type: 'ticket.updated',
      ticketId: ticket.id,
      number: ticket.number,
      changes,
      actor: tx.ctx.actor.name,
      actorUserId: actorUserId(tx),
    });
  });
}

export async function changeStatus(tx: TenantTx, deps: ServiceDeps, raw: unknown) {
  const input = parse(statusInput, raw);
  authorize(tx.ctx.actor, 'ticket:update');
  const ticket = await requireLocked(tx, input.ticketId);
  if (ticket.status === input.status) return { changed: false };
  const now = deps.now();
  await tx.db
    .updateTable('tickets')
    .set({ ...statusPatch(ticket.status, input.status, now), updatedAt: now, lastActivityAt: now })
    .where('workspaceId', '=', tx.workspaceId)
    .where('id', '=', ticket.id)
    .execute();
  await recordAudit(tx, {
    at: now,
    ticketId: ticket.id,
    action: 'ticket.status_changed',
    data: { from: ticket.status, to: input.status },
  });
  publishUpdate(tx, deps, ticket, ['status']);
  return { changed: true };
}

export async function changePriority(tx: TenantTx, deps: ServiceDeps, raw: unknown) {
  const input = parse(priorityInput, raw);
  authorize(tx.ctx.actor, 'ticket:update');
  const ticket = await requireLocked(tx, input.ticketId);
  if (ticket.priority === input.priority) return { changed: false };
  const now = deps.now();
  // SLA targets follow the priority; they are measured from ticket creation.
  const due = await scheduleSla(tx, { ...ticket, priority: input.priority });
  await tx.db
    .updateTable('tickets')
    .set({
      priority: input.priority,
      firstResponseDueAt: due.firstResponseDueAt,
      resolutionDueAt: due.resolutionDueAt,
      updatedAt: now,
    })
    .where('workspaceId', '=', tx.workspaceId)
    .where('id', '=', ticket.id)
    .execute();
  await recordAudit(tx, {
    at: now,
    ticketId: ticket.id,
    action: 'ticket.priority_changed',
    data: { from: ticket.priority, to: input.priority },
  });
  publishUpdate(tx, deps, ticket, ['priority']);
  return { changed: true };
}

export async function assignTicket(tx: TenantTx, deps: ServiceDeps, raw: unknown) {
  const input = parse(assignInput, raw);
  const ticket = await requireLocked(tx, input.ticketId);
  authorize(tx.ctx.actor, 'ticket:update');
  if (ticket.assigneeId === input.assigneeId) return { changed: false };
  authorizeAssignment(tx.ctx.actor, ticket.assigneeId, input.assigneeId);
  let assigneeName: string | null = null;
  if (input.assigneeId) {
    // Membership lookup runs under RLS: a user from another workspace is "not found".
    const member = await findMember(tx, input.assigneeId);
    if (!member) throw new ValidationError('Assignee is not a member of this workspace');
    assigneeName = member.name;
  }
  const now = deps.now();
  await tx.db
    .updateTable('tickets')
    .set({ assigneeId: input.assigneeId, updatedAt: now })
    .where('workspaceId', '=', tx.workspaceId)
    .where('id', '=', ticket.id)
    .execute();
  await recordAudit(tx, {
    at: now,
    ticketId: ticket.id,
    action: 'ticket.assigned',
    data: { from: ticket.assigneeId, to: input.assigneeId, toName: assigneeName },
  });
  publishUpdate(tx, deps, ticket, ['assignee']);
  return { changed: true };
}
