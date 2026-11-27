import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db } from '../db/database';
import { type TenantTx, withTenant } from '../db/tenant';
import { RESOLVED_STATUSES } from '../domain/types';
import { recordAudit } from '../repositories/audit';
import { nextTicketNumber } from '../repositories/tickets';
import type { ServiceDeps } from './deps';
import { scheduleSla } from './sla-scheduling';

/** Max clock skew accepted for signed webhooks; also bounds the replay window. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
export const SIGNATURE_HEADER = 'x-deskline-signature';
export const TIMESTAMP_HEADER = 'x-deskline-timestamp';

const messageId = z
  .string()
  .trim()
  .min(3)
  .max(998)
  .regex(/^<[^<>\s]+>$/, 'Message ids look like <local@domain>');

export const inboundEmailSchema = z.object({
  messageId,
  from: z.object({
    email: z.email().max(320),
    name: z.string().trim().max(120).optional(),
  }),
  to: z.email().max(320),
  subject: z.string().trim().max(300).default(''),
  text: z.string().trim().min(1).max(50_000),
  inReplyTo: messageId.optional(),
  references: z.array(messageId).max(50).default([]),
});

export type InboundEmail = z.infer<typeof inboundEmailSchema>;

export function signPayload(secret: string, timestamp: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Verifies `X-Deskline-Signature: sha256=<hex>` over `<timestamp>.<raw body>`.
 * Signing the timestamp with the body means a captured request cannot be
 * replayed outside the tolerance window, and comparison is constant-time.
 */
export function verifySignature(options: {
  secret: string;
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  now: Date;
}): boolean {
  const { secret, rawBody, timestamp, signature, now } = options;
  if (!timestamp || !signature || !/^\d{10,13}$/.test(timestamp)) return false;
  const ms = timestamp.length <= 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (Math.abs(now.getTime() - ms) > SIGNATURE_TOLERANCE_MS) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** System lookup (before any tenant context exists): which workspace owns this address? */
export async function findWorkspaceByInboundAddress(db: Db, address: string) {
  const row = await db
    .selectFrom('workspaces')
    .select(['id', 'webhookSecret'])
    .where((eb) => eb(eb.fn('lower', ['inboundAddress']), '=', address.trim().toLowerCase()))
    .executeTakeFirst();
  return row ?? null;
}

export type InboundResult =
  | { readonly outcome: 'created' | 'threaded'; readonly ticketId: string; readonly number: number }
  | { readonly outcome: 'duplicate'; readonly ticketId: string; readonly number: number };

async function findDuplicate(tx: TenantTx, id: string) {
  return tx.db
    .selectFrom('inboundEmails as i')
    .innerJoin('tickets as t', 't.id', 'i.ticketId')
    .select(['t.id as ticketId', 't.number'])
    .where('i.workspaceId', '=', tx.workspaceId)
    .where('i.messageId', '=', id)
    .executeTakeFirst();
}

async function upsertCustomer(tx: TenantTx, email: string, name: string | undefined) {
  const result = await sql<{ id: string }>`
    insert into customers (workspace_id, email, name)
    values (${tx.workspaceId}, ${email.toLowerCase()}, ${name ?? null})
    on conflict (workspace_id, lower(email))
      do update set name = coalesce(excluded.name, customers.name)
    returning id
  `.execute(tx.db);
  const row = result.rows[0];
  if (!row) throw new Error('customer upsert returned no row');
  return row.id;
}

/**
 * Finds the ticket an inbound email replies to: first by RFC 5322 threading
 * headers (In-Reply-To, then References, newest first), then by a `[#123]`
 * subject token. The subject fallback only matches when the sender is the
 * ticket's customer, so guessing a ticket number cannot inject into it.
 */
async function findThread(tx: TenantTx, email: InboundEmail, customerId: string) {
  const candidates = [email.inReplyTo, ...[...email.references].reverse()].filter(
    (v): v is string => Boolean(v),
  );
  if (candidates.length > 0) {
    const byHeader = await tx.db
      .selectFrom('messages as m')
      .innerJoin('tickets as t', 't.id', 'm.ticketId')
      .select(['t.id', 't.number', 't.status'])
      .where('m.workspaceId', '=', tx.workspaceId)
      .where('m.emailMessageId', 'in', candidates)
      .orderBy('m.createdAt', 'desc')
      .executeTakeFirst();
    if (byHeader) return byHeader;
  }
  const token = /\[#(\d{1,9})\]/.exec(email.subject);
  if (token) {
    const bySubject = await tx.db
      .selectFrom('tickets')
      .select(['id', 'number', 'status'])
      .where('workspaceId', '=', tx.workspaceId)
      .where('number', '=', Number(token[1]))
      .where('customerId', '=', customerId)
      .executeTakeFirst();
    if (bySubject) return bySubject;
  }
  return null;
}

async function processInTx(
  tx: TenantTx,
  deps: ServiceDeps,
  email: InboundEmail,
): Promise<InboundResult> {
  const duplicate = await findDuplicate(tx, email.messageId);
  if (duplicate) return { outcome: 'duplicate', ...duplicate };

  const now = deps.now();
  const customerId = await upsertCustomer(tx, email.from.email, email.from.name);
  const thread = await findThread(tx, email, customerId);
  const actor = email.from.name ?? email.from.email;

  let ticket: { id: string; number: number };
  let outcome: 'created' | 'threaded';
  if (thread) {
    outcome = 'threaded';
    ticket = thread;
    const reopen = RESOLVED_STATUSES.includes(thread.status);
    await tx.db
      .updateTable('tickets')
      .set({
        lastActivityAt: now,
        updatedAt: now,
        // A customer reply wakes up a pending ticket and reopens a resolved one.
        ...(thread.status !== 'open' ? { status: 'open' as const } : {}),
        ...(reopen ? { resolvedAt: null } : {}),
      })
      .where('workspaceId', '=', tx.workspaceId)
      .where('id', '=', thread.id)
      .execute();
    if (thread.status !== 'open') {
      await recordAudit(tx, {
        at: now,
        ticketId: thread.id,
        action: 'ticket.status_changed',
        actorType: 'customer',
        data: { from: thread.status, to: 'open', reason: 'customer_reply' },
      });
    }
  } else {
    outcome = 'created';
    const number = await nextTicketNumber(tx);
    const subject = email.subject || '(no subject)';
    const created = await tx.db
      .insertInto('tickets')
      .values({
        workspaceId: tx.workspaceId,
        number,
        subject,
        customerId,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
      .returning(['id', 'number'])
      .executeTakeFirstOrThrow();
    const due = await scheduleSla(tx, { id: created.id, createdAt: now, priority: 'normal' });
    await tx.db
      .updateTable('tickets')
      .set({ firstResponseDueAt: due.firstResponseDueAt, resolutionDueAt: due.resolutionDueAt })
      .where('workspaceId', '=', tx.workspaceId)
      .where('id', '=', created.id)
      .execute();
    ticket = created;
    await recordAudit(tx, {
      at: now,
      ticketId: created.id,
      action: 'ticket.created',
      actorType: 'customer',
      data: { channel: 'email', from: email.from.email },
    });
  }

  await tx.db
    .insertInto('messages')
    .values({
      workspaceId: tx.workspaceId,
      ticketId: ticket.id,
      authorType: 'customer',
      customerId,
      body: email.text,
      emailMessageId: email.messageId,
      createdAt: now,
    })
    .execute();
  // The idempotency key. A concurrent delivery of the same message id blocks
  // on this unique key and then fails, rolling its whole transaction back.
  await tx.db
    .insertInto('inboundEmails')
    .values({
      workspaceId: tx.workspaceId,
      messageId: email.messageId,
      ticketId: ticket.id,
      outcome,
    })
    .execute();
  if (outcome === 'threaded') {
    await recordAudit(tx, {
      at: now,
      ticketId: ticket.id,
      action: 'ticket.customer_replied',
      actorType: 'customer',
      data: { from: email.from.email },
    });
  }

  tx.afterCommit(() => {
    deps.broker.publish(
      tx.workspaceId,
      outcome === 'created'
        ? {
            type: 'ticket.created',
            ticketId: ticket.id,
            number: ticket.number,
            subject: email.subject || '(no subject)',
            actor,
            actorUserId: null,
          }
        : {
            type: 'ticket.message',
            ticketId: ticket.id,
            number: ticket.number,
            internal: false,
            authorType: 'customer',
            actor,
            actorUserId: null,
          },
    );
  });
  return { outcome, ticketId: ticket.id, number: ticket.number };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/** Idempotently turns one inbound email into a new ticket or a reply on an existing one. */
export async function processInboundEmail(
  db: Db,
  deps: ServiceDeps,
  workspaceId: string,
  email: InboundEmail,
): Promise<InboundResult> {
  const ctx = { workspaceId, actor: { kind: 'system', name: 'Inbound email' } } as const;
  try {
    return await withTenant(db, ctx, (tx) => processInTx(tx, deps, email));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost a race with a concurrent delivery of the same message: report the winner.
    const winner = await withTenant(db, ctx, (tx) => findDuplicate(tx, email.messageId));
    if (!winner) throw error;
    return { outcome: 'duplicate', ...winner };
  }
}
