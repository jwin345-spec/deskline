import { sql } from 'kysely';
import type { TenantTx } from '../db/tenant';
import { authorize } from '../domain/rbac';
import { PRIORITIES, type Priority, TICKET_STATUSES, type TicketStatus } from '../domain/types';

export interface DashboardStats {
  readonly byStatus: Record<TicketStatus, number>;
  readonly openByPriority: Record<Priority, number>;
  readonly unassignedOpen: number;
  readonly breachesLast7Days: number;
  readonly activeTicketsInBreach: number;
  /** Median seconds from ticket creation to first agent reply, last 30 days; null if no data. */
  readonly medianFirstResponseSeconds: number | null;
  readonly respondedLast30Days: number;
  readonly recentBreaches: readonly {
    ticketId: string;
    number: number;
    subject: string;
    kind: 'first_response' | 'resolution';
    breachedAt: Date;
  }[];
}

/** Everything is computed in SQL from the live tables; nothing is pre-aggregated. */
export async function getDashboard(tx: TenantTx, now: Date): Promise<DashboardStats> {
  authorize(tx.ctx.actor, 'dashboard:read');
  const ws = tx.workspaceId;
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const since7 = new Date(now.getTime() - 7 * 86_400_000);

  const statusRows = await tx.db
    .selectFrom('tickets')
    .select(['status', sql<number>`count(*)::int`.as('n')])
    .where('workspaceId', '=', ws)
    .groupBy('status')
    .execute();
  const byStatus = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<
    TicketStatus,
    number
  >;
  for (const row of statusRows) byStatus[row.status] = row.n;

  const priorityRows = await tx.db
    .selectFrom('tickets')
    .select(['priority', sql<number>`count(*)::int`.as('n')])
    .where('workspaceId', '=', ws)
    .where('status', 'in', ['open', 'pending'])
    .groupBy('priority')
    .execute();
  const openByPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0])) as Record<
    Priority,
    number
  >;
  for (const row of priorityRows) openByPriority[row.priority] = row.n;

  const counts = await sql<{
    unassignedOpen: number;
    breachesLast7Days: number;
    activeTicketsInBreach: number;
    medianFirstResponseSeconds: number | null;
    respondedLast30Days: number;
  }>`
    select
      (select count(*)::int from tickets
        where workspace_id = ${ws} and status in ('open', 'pending') and assignee_id is null)
        as unassigned_open,
      (select count(*)::int from sla_breaches
        where workspace_id = ${ws} and breached_at >= ${since7}) as breaches_last7_days,
      (select count(distinct b.ticket_id)::int from sla_breaches b
         join tickets t on t.id = b.ticket_id
        where b.workspace_id = ${ws} and t.status in ('open', 'pending')) as active_tickets_in_breach,
      (select percentile_cont(0.5) within group (
                order by extract(epoch from first_response_at - created_at))::float8
         from tickets
        where workspace_id = ${ws} and first_response_at is not null and created_at >= ${since30})
        as median_first_response_seconds,
      (select count(*)::int from tickets
        where workspace_id = ${ws} and first_response_at is not null and created_at >= ${since30})
        as responded_last30_days
  `.execute(tx.db);
  const row = counts.rows[0];

  const recentBreaches = await tx.db
    .selectFrom('slaBreaches as b')
    .innerJoin('tickets as t', 't.id', 'b.ticketId')
    .select(['t.id as ticketId', 't.number', 't.subject', 'b.kind', 'b.breachedAt'])
    .where('b.workspaceId', '=', ws)
    .orderBy('b.breachedAt', 'desc')
    .limit(8)
    .execute();

  return {
    byStatus,
    openByPriority,
    unassignedOpen: row?.unassignedOpen ?? 0,
    breachesLast7Days: row?.breachesLast7Days ?? 0,
    activeTicketsInBreach: row?.activeTicketsInBreach ?? 0,
    medianFirstResponseSeconds:
      row?.medianFirstResponseSeconds === null || row?.medianFirstResponseSeconds === undefined
        ? null
        : Number(row.medianFirstResponseSeconds),
    respondedLast30Days: row?.respondedLast30Days ?? 0,
    recentBreaches,
  };
}
