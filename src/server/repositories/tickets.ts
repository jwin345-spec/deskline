import { sql } from 'kysely';
import type { TenantTx } from '../db/tenant';
import type { Priority, TicketStatus } from '../domain/types';
import { type Cursor, encodeCursor } from '../lib/cursor';

export interface TicketListFilters {
  readonly status?: TicketStatus | 'active' | undefined;
  readonly priority?: Priority | undefined;
  /** `me`, `unassigned`, or a user id. */
  readonly assignee?: string | undefined;
  readonly q?: string | undefined;
  readonly cursor?: Cursor | null | undefined;
  readonly limit?: number | undefined;
  /** The viewing user, used to resolve `assignee=me`. */
  readonly viewerId?: string | undefined;
}

export interface TicketListItem {
  readonly id: string;
  readonly number: number;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly priority: Priority;
  readonly customerName: string | null;
  readonly customerEmail: string;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
  readonly firstResponseAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly firstResponseDueAt: Date | null;
  readonly resolutionDueAt: Date | null;
  readonly snippet: string | null;
  readonly breachCount: number;
}

export interface TicketPage {
  readonly items: readonly TicketListItem[];
  readonly nextCursor: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inbox query: filters, full-text search and keyset pagination ordered by
 * (last_activity_at desc, id desc). Keyset rather than OFFSET so pages stay
 * stable while new tickets arrive at the top and cost stays flat with depth.
 */
export async function listTickets(tx: TenantTx, filters: TicketListFilters): Promise<TicketPage> {
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
  let query = tx.db
    .selectFrom('tickets as t')
    .innerJoin('customers as c', 'c.id', 't.customerId')
    .leftJoin('users as a', 'a.id', 't.assigneeId')
    .select([
      't.id',
      't.number',
      't.subject',
      't.status',
      't.priority',
      'c.name as customerName',
      'c.email as customerEmail',
      't.assigneeId',
      'a.name as assigneeName',
      't.lastActivityAt',
      't.createdAt',
      't.firstResponseAt',
      't.resolvedAt',
      't.firstResponseDueAt',
      't.resolutionDueAt',
      sql<string>`t.last_activity_at::text`.as('cursorTs'),
      (eb) =>
        eb
          .selectFrom('messages as m')
          .select('m.body')
          .whereRef('m.ticketId', '=', 't.id')
          .where('m.internal', '=', false)
          .orderBy('m.createdAt', 'desc')
          .limit(1)
          .as('snippet'),
      (eb) =>
        eb
          .selectFrom('slaBreaches as b')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('b.ticketId', '=', 't.id')
          .as('breachCount'),
    ])
    .where('t.workspaceId', '=', tx.workspaceId);

  if (filters.status === 'active') {
    query = query.where('t.status', 'in', ['open', 'pending']);
  } else if (filters.status) {
    query = query.where('t.status', '=', filters.status);
  }
  if (filters.priority) {
    query = query.where('t.priority', '=', filters.priority);
  }
  if (filters.assignee === 'unassigned') {
    query = query.where('t.assigneeId', 'is', null);
  } else if (filters.assignee === 'me' && filters.viewerId) {
    query = query.where('t.assigneeId', '=', filters.viewerId);
  } else if (filters.assignee && UUID.test(filters.assignee)) {
    query = query.where('t.assigneeId', '=', filters.assignee);
  }

  const q = filters.q?.trim();
  if (q) {
    const numberMatch = /^#?(\d{1,9})$/.exec(q);
    query = query.where((eb) =>
      eb.or([
        eb(sql`t.search_vector`, '@@', sql`websearch_to_tsquery('english', ${q})`),
        eb(eb.fn('lower', ['c.email']), '=', q.toLowerCase()),
        ...(numberMatch ? [eb('t.number', '=', Number(numberMatch[1]))] : []),
      ]),
    );
  }

  if (filters.cursor) {
    const { t, i } = filters.cursor;
    query = query.where(sql<boolean>`(t.last_activity_at, t.id) < (${t}::timestamptz, ${i}::uuid)`);
  }

  const rows = await query
    .orderBy('t.lastActivityAt', 'desc')
    .orderBy('t.id', 'desc')
    .limit(limit + 1)
    .execute();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(({ cursorTs: _cursorTs, ...item }) => ({
      ...item,
      breachCount: item.breachCount ?? 0,
    })),
    nextCursor: hasMore && last ? encodeCursor({ t: last.cursorTs, i: last.id }) : null,
  };
}

export interface TicketDetail {
  readonly id: string;
  readonly number: number;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly priority: Priority;
  readonly customerId: string;
  readonly customerName: string | null;
  readonly customerEmail: string;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastActivityAt: Date;
  readonly firstResponseAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly firstResponseDueAt: Date | null;
  readonly resolutionDueAt: Date | null;
}

/** Returns null both for missing ids and ids that belong to another workspace. */
export async function findTicket(tx: TenantTx, ticketId: string): Promise<TicketDetail | null> {
  if (!UUID.test(ticketId)) return null;
  const row = await tx.db
    .selectFrom('tickets as t')
    .innerJoin('customers as c', 'c.id', 't.customerId')
    .leftJoin('users as a', 'a.id', 't.assigneeId')
    .select([
      't.id',
      't.number',
      't.subject',
      't.status',
      't.priority',
      't.customerId',
      'c.name as customerName',
      'c.email as customerEmail',
      't.assigneeId',
      'a.name as assigneeName',
      't.createdAt',
      't.updatedAt',
      't.lastActivityAt',
      't.firstResponseAt',
      't.resolvedAt',
      't.firstResponseDueAt',
      't.resolutionDueAt',
    ])
    .where('t.workspaceId', '=', tx.workspaceId)
    .where('t.id', '=', ticketId)
    .executeTakeFirst();
  return row ?? null;
}

/** Row lock for read-modify-write updates (status, assignment, priority). */
export async function lockTicket(tx: TenantTx, ticketId: string) {
  if (!UUID.test(ticketId)) return null;
  const row = await tx.db
    .selectFrom('tickets')
    .select([
      'id',
      'number',
      'subject',
      'status',
      'priority',
      'assigneeId',
      'createdAt',
      'firstResponseAt',
      'resolvedAt',
      'firstResponseDueAt',
      'resolutionDueAt',
    ])
    .where('workspaceId', '=', tx.workspaceId)
    .where('id', '=', ticketId)
    .forUpdate()
    .executeTakeFirst();
  return row ?? null;
}

export interface ThreadMessage {
  readonly id: string;
  readonly authorType: 'customer' | 'agent' | 'system';
  readonly authorName: string | null;
  readonly authorEmail: string | null;
  readonly body: string;
  readonly internal: boolean;
  readonly createdAt: Date;
}

export async function listMessages(tx: TenantTx, ticketId: string): Promise<ThreadMessage[]> {
  return tx.db
    .selectFrom('messages as m')
    .leftJoin('users as u', 'u.id', 'm.authorUserId')
    .leftJoin('customers as c', 'c.id', 'm.customerId')
    .select((eb) => [
      'm.id',
      'm.authorType',
      eb.fn.coalesce('u.name', 'c.name').as('authorName'),
      eb.fn.coalesce('u.email', 'c.email').as('authorEmail'),
      'm.body',
      'm.internal',
      'm.createdAt',
    ])
    .where('m.workspaceId', '=', tx.workspaceId)
    .where('m.ticketId', '=', ticketId)
    .orderBy('m.createdAt')
    .orderBy('m.id')
    .execute();
}

/** Allocates the next per-workspace ticket number (row-locked, gap-free per commit). */
export async function nextTicketNumber(tx: TenantTx): Promise<number> {
  const row = await tx.db
    .updateTable('workspaces')
    .set((eb) => ({ ticketSeq: eb('ticketSeq', '+', 1) }))
    .where('id', '=', tx.workspaceId)
    .returning('ticketSeq')
    .executeTakeFirstOrThrow();
  return row.ticketSeq;
}
