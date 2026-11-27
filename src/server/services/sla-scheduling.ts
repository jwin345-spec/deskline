import type { TenantTx } from '../db/tenant';
import { computeDueDates, DEFAULT_SLA_POLICIES, type SlaPolicy } from '../domain/sla';
import type { Priority } from '../domain/types';
import { enqueueJob } from '../repositories/jobs';

export const SLA_CHECK_JOB = 'sla.check';

export async function loadSlaPolicy(tx: TenantTx, priority: Priority): Promise<SlaPolicy> {
  const row = await tx.db
    .selectFrom('slaPolicies')
    .select(['firstResponseMinutes', 'resolutionMinutes'])
    .where('workspaceId', '=', tx.workspaceId)
    .where('priority', '=', priority)
    .executeTakeFirst();
  return row ?? DEFAULT_SLA_POLICIES[priority];
}

/**
 * Computes a ticket's SLA targets and schedules one check job per target, in
 * the caller's transaction. The worker re-reads the ticket when the job fires
 * and ignores jobs whose due date no longer matches (e.g. after a priority
 * change rescheduled them), so stale jobs never need to be cancelled.
 */
export async function scheduleSla(
  tx: TenantTx,
  ticket: { id: string; createdAt: Date; priority: Priority },
) {
  const policy = await loadSlaPolicy(tx, ticket.priority);
  const due = computeDueDates(ticket.createdAt, policy);
  await enqueueJob(tx, {
    kind: SLA_CHECK_JOB,
    payload: {
      ticketId: ticket.id,
      kind: 'first_response',
      dueAt: due.firstResponseDueAt.toISOString(),
    },
    runAt: due.firstResponseDueAt,
  });
  await enqueueJob(tx, {
    kind: SLA_CHECK_JOB,
    payload: { ticketId: ticket.id, kind: 'resolution', dueAt: due.resolutionDueAt.toISOString() },
    runAt: due.resolutionDueAt,
  });
  return due;
}
