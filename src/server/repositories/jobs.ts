import { sql } from 'kysely';
import type { Db } from '../db/database';
import type { TenantTx } from '../db/tenant';

export interface EnqueueInput {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly runAt: Date;
}

/** Enqueues a job inside a tenant transaction, so it exists iff the change commits. */
export async function enqueueJob(tx: TenantTx, input: EnqueueInput): Promise<void> {
  await tx.db
    .insertInto('jobs')
    .values({
      workspaceId: tx.workspaceId,
      kind: input.kind,
      payload: JSON.stringify(input.payload),
      runAt: input.runAt,
    })
    .execute();
}

export interface ClaimedJob {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/**
 * Claims up to `limit` due jobs for `workerId`.
 *
 * `FOR UPDATE SKIP LOCKED` lets any number of workers poll the same table
 * without blocking on, or double-claiming, each other's rows. The claim is a
 * lease: `locked_until` marks when a crashed worker's job becomes claimable
 * again, so a job is never lost, only (rarely) retried.
 */
export async function claimJobs(
  db: Db,
  workerId: string,
  options: { limit: number; leaseMs: number; now: Date },
): Promise<ClaimedJob[]> {
  const leaseUntil = new Date(options.now.getTime() + options.leaseMs);
  const result = await sql<ClaimedJob>`
    with due as (
      select id from jobs
       where (status = 'queued' and run_at <= ${options.now})
          or (status = 'running' and locked_until < ${options.now})
       order by run_at
       limit ${options.limit}
       for update skip locked
    )
    update jobs j
       set status = 'running',
           attempts = j.attempts + 1,
           locked_by = ${workerId},
           locked_until = ${leaseUntil},
           updated_at = ${options.now}
      from due
     where j.id = due.id
    returning j.id, j.workspace_id, j.kind, j.payload, j.attempts, j.max_attempts
  `.execute(db);
  return result.rows.map((row) => ({
    ...row,
    payload:
      typeof row.payload === 'string'
        ? (JSON.parse(row.payload) as Record<string, unknown>)
        : row.payload,
  }));
}

export async function completeJob(
  db: Db,
  jobId: string,
  workerId: string,
  now: Date,
): Promise<void> {
  await db
    .updateTable('jobs')
    .set({ status: 'done', lockedBy: null, lockedUntil: null, updatedAt: now })
    .where('id', '=', jobId)
    .where('lockedBy', '=', workerId)
    .execute();
}

/** Exponential backoff (5s, 10s, 20s, ...) until max_attempts, then `failed`. */
export async function failJob(
  db: Db,
  job: ClaimedJob,
  workerId: string,
  error: unknown,
  now: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const backoffMs = 5_000 * 2 ** Math.max(job.attempts - 1, 0);
  await db
    .updateTable('jobs')
    .set({
      status: exhausted ? 'failed' : 'queued',
      runAt: new Date(now.getTime() + backoffMs),
      lockedBy: null,
      lockedUntil: null,
      lastError: message.slice(0, 2000),
      updatedAt: now,
    })
    .where('id', '=', job.id)
    .where('lockedBy', '=', workerId)
    .execute();
}
