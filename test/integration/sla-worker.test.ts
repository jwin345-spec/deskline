import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/server/db/tenant';
import { claimJobs, completeJob } from '../../src/server/repositories/jobs';
import { JobWorker, runSlaCheck } from '../../src/server/services/sla-worker';
import { changePriority, changeStatus, replyToTicket } from '../../src/server/services/tickets';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
  createTicket,
  createWorkspace,
  makeDeps,
  type WorkspaceFixture,
} from '../helpers/fixtures';

const HOUR = 3_600_000;

describe('SLA worker', () => {
  let t: TestDatabase;
  let ws: WorkspaceFixture;

  beforeAll(async () => {
    t = await createTestDatabase();
    ws = await createWorkspace(t.db, 'sla');
  });
  afterAll(() => t.destroy());

  async function clearJobs() {
    await t.db.deleteFrom('jobs').execute();
  }

  async function breachesFor(ticketId: string) {
    return t.db
      .selectFrom('slaBreaches')
      .select(['kind'])
      .where('ticketId', '=', ticketId)
      .orderBy('kind')
      .execute();
  }

  it('does nothing before targets are due', async () => {
    await clearJobs();
    const { deps, clock } = makeDeps();
    await createTicket(t.db, deps, ws);
    const worker = new JobWorker(t.db, deps, { workerId: 'w1' });
    clock.advance(HOUR);
    expect(await worker.tick()).toBe(0);
  });

  it('records a first-response breach once the target passes without a reply', async () => {
    await clearJobs();
    const { deps, clock, events } = makeDeps();
    const { ticketId } = await createTicket(t.db, deps, ws);
    const worker = new JobWorker(t.db, deps, { workerId: 'w1' });
    clock.advance(8 * HOUR + 1000);
    expect(await worker.tick()).toBe(1);
    expect(await breachesFor(ticketId)).toEqual([{ kind: 'first_response' }]);
    expect(events.at(-1)?.event).toMatchObject({
      type: 'sla.breached',
      ticketId,
      kind: 'first_response',
    });
    const audit = await t.db
      .selectFrom('auditEvents')
      .select(['action', 'actorType'])
      .where('ticketId', '=', ticketId)
      .where('action', '=', 'sla.breached')
      .execute();
    expect(audit).toEqual([{ action: 'sla.breached', actorType: 'system' }]);
  });

  it('records nothing when the agent replied and resolved in time', async () => {
    await clearJobs();
    const { deps, clock } = makeDeps();
    const { ticketId } = await createTicket(t.db, deps, ws);
    clock.advance(HOUR);
    await withTenant(t.db, ws.ctx('agent'), (tx) =>
      replyToTicket(tx, deps, { ticketId, body: 'On it', statusAfter: 'resolved' }),
    );
    const worker = new JobWorker(t.db, deps, { workerId: 'w1' });
    clock.advance(100 * HOUR);
    expect(await worker.tick()).toBe(2);
    expect(await breachesFor(ticketId)).toEqual([]);
    const statuses = await t.db.selectFrom('jobs').select('status').execute();
    expect(statuses.every((j) => j.status === 'done')).toBe(true);
  });

  it('records a resolution breach for a ticket answered but never resolved', async () => {
    await clearJobs();
    const { deps, clock } = makeDeps();
    const { ticketId } = await createTicket(t.db, deps, ws);
    clock.advance(HOUR);
    await withTenant(t.db, ws.ctx('agent'), (tx) =>
      replyToTicket(tx, deps, { ticketId, body: 'Looking' }),
    );
    clock.advance(80 * HOUR);
    await new JobWorker(t.db, deps, { workerId: 'w1' }).tick();
    expect(await breachesFor(ticketId)).toEqual([{ kind: 'resolution' }]);
  });

  it('follows priority changes: old jobs become stale, new targets apply', async () => {
    await clearJobs();
    const { deps, clock } = makeDeps();
    const { ticketId } = await createTicket(t.db, deps, ws);
    clock.advance(60_000);
    await withTenant(t.db, ws.ctx('admin'), (tx) =>
      changePriority(tx, deps, { ticketId, priority: 'urgent' }),
    );
    clock.advance(31 * 60_000); // past the urgent 30-minute target, well before normal's 8 hours
    await new JobWorker(t.db, deps, { workerId: 'w1' }).tick();
    expect(await breachesFor(ticketId)).toEqual([{ kind: 'first_response' }]);

    // The original normal-priority jobs fire later and are ignored as stale.
    clock.advance(100 * HOUR);
    const outcomes: string[] = [];
    const due = await claimJobs(t.db, 'w2', { limit: 50, leaseMs: 60_000, now: clock.now() });
    for (const job of due) {
      outcomes.push(await runSlaCheck(t.db, deps, job));
      await completeJob(t.db, job.id, 'w2', clock.now());
    }
    expect(outcomes.sort()).toEqual(['breached', 'stale', 'stale']);
  });

  it('never records the same breach twice', async () => {
    await clearJobs();
    const { deps, clock } = makeDeps();
    const { ticketId } = await createTicket(t.db, deps, ws);
    clock.advance(9 * HOUR);
    const [job] = await claimJobs(t.db, 'w1', { limit: 1, leaseMs: 60_000, now: clock.now() });
    expect(job).toBeDefined();
    expect(await runSlaCheck(t.db, deps, job!)).toBe('breached');
    expect(await runSlaCheck(t.db, deps, job!)).toBe('already_recorded');
    expect(await breachesFor(ticketId)).toHaveLength(1);
  });

  it('claims each job exactly once across workers (SKIP LOCKED)', async () => {
    await clearJobs();
    const { deps, clock } = makeDeps();
    for (let i = 0; i < 5; i++) await createTicket(t.db, deps, ws);
    clock.advance(200 * HOUR);
    const [a, b, c] = await Promise.all([
      claimJobs(t.db, 'a', { limit: 4, leaseMs: 60_000, now: clock.now() }),
      claimJobs(t.db, 'b', { limit: 4, leaseMs: 60_000, now: clock.now() }),
      claimJobs(t.db, 'c', { limit: 4, leaseMs: 60_000, now: clock.now() }),
    ]);
    const ids = [...a, ...b, ...c].map((j) => j.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('re-claims a job whose worker died once its lease expires', async () => {
    await clearJobs();
    const { deps, clock } = makeDeps();
    await createTicket(t.db, deps, ws);
    clock.advance(9 * HOUR);
    const crashed = await claimJobs(t.db, 'dead', { limit: 1, leaseMs: 60_000, now: clock.now() });
    expect(crashed).toHaveLength(1);
    expect(
      await claimJobs(t.db, 'alive', { limit: 1, leaseMs: 60_000, now: clock.now() }),
    ).toHaveLength(0);
    clock.advance(61_000);
    const reclaimed = await claimJobs(t.db, 'alive', {
      limit: 1,
      leaseMs: 60_000,
      now: clock.now(),
    });
    expect(reclaimed.map((j) => j.id)).toEqual(crashed.map((j) => j.id));
    expect(reclaimed[0]?.attempts).toBe(2);
  });

  it('retries failing jobs with backoff, then marks them failed', async () => {
    await clearJobs();
    const { deps, clock } = makeDeps();
    await t.db
      .insertInto('jobs')
      .values({
        workspaceId: ws.id,
        kind: 'unknown.kind',
        payload: '{}',
        runAt: clock.now(),
        maxAttempts: 2,
      })
      .execute();
    const worker = new JobWorker(t.db, deps, { workerId: 'w1' });
    expect(await worker.tick()).toBe(1);
    let job = await t.db.selectFrom('jobs').selectAll().executeTakeFirstOrThrow();
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });
    expect(job.lastError).toMatch(/No handler/);
    expect(await worker.tick()).toBe(0); // backing off
    clock.advance(6_000);
    expect(await worker.tick()).toBe(1);
    job = await t.db.selectFrom('jobs').selectAll().executeTakeFirstOrThrow();
    expect(job).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('reopening keeps the original targets: a late resolution is still a breach', async () => {
    await clearJobs();
    const { deps, clock } = makeDeps();
    const { ticketId } = await createTicket(t.db, deps, ws);
    clock.advance(HOUR);
    await withTenant(t.db, ws.ctx('agent'), (tx) =>
      changeStatus(tx, deps, { ticketId, status: 'resolved' }),
    );
    await withTenant(t.db, ws.ctx('agent'), (tx) =>
      changeStatus(tx, deps, { ticketId, status: 'open' }),
    );
    clock.advance(80 * HOUR);
    await new JobWorker(t.db, deps, { workerId: 'w1' }).tick();
    expect((await breachesFor(ticketId)).map((b) => b.kind)).toContain('resolution');
  });
});
