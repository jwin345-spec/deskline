import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/database';
import { isFirstResponseBreached, isResolutionBreached } from '../domain/sla';
import { type ClaimedJob, claimJobs, completeJob, failJob } from '../repositories/jobs';
import type { ServiceDeps } from './deps';
import { SLA_CHECK_JOB } from './sla-scheduling';

const slaPayload = z.object({
  ticketId: z.uuid(),
  kind: z.enum(['first_response', 'resolution']),
  dueAt: z.iso.datetime(),
});

export type SlaCheckOutcome = 'breached' | 'met' | 'stale' | 'missing' | 'already_recorded';

/**
 * Evaluates one SLA target. Runs as the system role (no tenant context): the
 * worker serves every workspace, and each write below still names the job's
 * workspace explicitly.
 */
export async function runSlaCheck(
  db: Db,
  deps: ServiceDeps,
  job: Pick<ClaimedJob, 'workspaceId' | 'payload'>,
): Promise<SlaCheckOutcome> {
  const payload = slaPayload.parse(job.payload);
  const workspaceId = job.workspaceId;
  if (!workspaceId) throw new Error('sla.check job without workspace');
  const now = deps.now();

  const result = await db.transaction().execute(async (trx) => {
    const ticket = await trx
      .selectFrom('tickets')
      .select([
        'id',
        'number',
        'status',
        'firstResponseAt',
        'resolvedAt',
        'firstResponseDueAt',
        'resolutionDueAt',
      ])
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', payload.ticketId)
      .forUpdate()
      .executeTakeFirst();
    if (!ticket) return { outcome: 'missing' as const };

    const currentDue =
      payload.kind === 'first_response' ? ticket.firstResponseDueAt : ticket.resolutionDueAt;
    // A priority change rescheduled this target; a newer job owns it now.
    if (!currentDue || currentDue.getTime() !== new Date(payload.dueAt).getTime()) {
      return { outcome: 'stale' as const };
    }
    const breached =
      payload.kind === 'first_response'
        ? isFirstResponseBreached(ticket, now)
        : isResolutionBreached(ticket, now);
    if (!breached) return { outcome: 'met' as const };

    const inserted = await trx
      .insertInto('slaBreaches')
      .values({
        workspaceId,
        ticketId: ticket.id,
        kind: payload.kind,
        dueAt: currentDue,
        breachedAt: now,
      })
      .onConflict((oc) => oc.columns(['ticketId', 'kind']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return { outcome: 'already_recorded' as const };

    await trx
      .insertInto('auditEvents')
      .values({
        workspaceId,
        ticketId: ticket.id,
        actorType: 'system',
        actorUserId: null,
        action: 'sla.breached',
        data: JSON.stringify({
          kind: payload.kind,
          dueAt: currentDue.toISOString(),
          system: 'SLA worker',
        }),
        createdAt: now,
      })
      .execute();
    return { outcome: 'breached' as const, number: ticket.number, ticketId: ticket.id };
  });

  if (result.outcome === 'breached') {
    deps.broker.publish(workspaceId, {
      type: 'sla.breached',
      ticketId: result.ticketId,
      number: result.number,
      kind: payload.kind,
      actor: 'SLA worker',
      actorUserId: null,
    });
  }
  return result.outcome;
}

export type JobHandler = (job: ClaimedJob) => Promise<unknown>;

export interface WorkerOptions {
  readonly pollMs?: number;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly workerId?: string;
}

/**
 * In-process, DB-backed job runner. Each tick claims a batch with SKIP LOCKED,
 * runs each job in its own transaction and records success or a backed-off
 * retry. Any number of instances can run it against one database.
 */
export class JobWorker {
  readonly id: string;
  readonly #db: Db;
  readonly #deps: ServiceDeps;
  readonly #handlers: Map<string, JobHandler>;
  readonly #pollMs: number;
  readonly #batchSize: number;
  readonly #leaseMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<number> | undefined;
  #stopped = true;

  constructor(db: Db, deps: ServiceDeps, options: WorkerOptions = {}) {
    this.#db = db;
    this.#deps = deps;
    this.id = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.#pollMs = options.pollMs ?? 2_000;
    this.#batchSize = options.batchSize ?? 20;
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#handlers = new Map<string, JobHandler>([
      [SLA_CHECK_JOB, (job) => runSlaCheck(this.#db, this.#deps, job)],
    ]);
  }

  /** Processes one batch of due jobs; returns how many were claimed. */
  async tick(): Promise<number> {
    const jobs = await claimJobs(this.#db, this.id, {
      limit: this.#batchSize,
      leaseMs: this.#leaseMs,
      now: this.#deps.now(),
    });
    for (const job of jobs) {
      const handler = this.#handlers.get(job.kind);
      try {
        if (!handler) throw new Error(`No handler for job kind "${job.kind}"`);
        await handler(job);
        await completeJob(this.#db, job.id, this.id, this.#deps.now());
      } catch (error) {
        await failJob(this.#db, job, this.id, error, this.#deps.now());
      }
    }
    return jobs.length;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const loop = async () => {
      if (this.#stopped) return;
      try {
        this.#running = this.tick();
        const claimed = await this.#running;
        // Drain backlogs quickly; otherwise wait for the next poll.
        this.#timer = setTimeout(() => void loop(), claimed >= this.#batchSize ? 0 : this.#pollMs);
      } catch (error) {
        console.error('[sla-worker] tick failed', error);
        this.#timer = setTimeout(() => void loop(), this.#pollMs);
      }
    };
    this.#timer = setTimeout(() => void loop(), 0);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running?.catch(() => undefined);
  }
}
