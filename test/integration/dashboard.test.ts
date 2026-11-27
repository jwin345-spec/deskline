import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/server/db/tenant';
import { getDashboard } from '../../src/server/services/dashboard';
import { JobWorker } from '../../src/server/services/sla-worker';
import { changeStatus, replyToTicket } from '../../src/server/services/tickets';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
  createTicket,
  createWorkspace,
  makeDeps,
  type WorkspaceFixture,
} from '../helpers/fixtures';

const MIN = 60_000;

describe('dashboard', () => {
  let t: TestDatabase;
  let ws: WorkspaceFixture;
  const { deps, clock } = makeDeps();

  beforeAll(async () => {
    t = await createTestDatabase();
    ws = await createWorkspace(t.db, 'dash');
    // Three tickets answered after 10, 30 and 90 minutes; one never answered.
    for (const minutes of [10, 30, 90]) {
      const { ticketId } = await createTicket(t.db, deps, ws);
      clock.advance(minutes * MIN);
      await withTenant(t.db, ws.ctx('agent'), (tx) =>
        replyToTicket(tx, deps, { ticketId, body: 'Hi' }),
      );
    }
    const { ticketId } = await createTicket(t.db, deps, ws);
    await createTicket(t.db, deps, ws);
    await withTenant(t.db, ws.ctx('agent'), (tx) =>
      changeStatus(tx, deps, { ticketId, status: 'pending' }),
    );
    clock.advance(9 * 60 * MIN);
    await new JobWorker(t.db, deps, { workerId: 'dash' }).tick();
  });
  afterAll(() => t.destroy());

  it('computes counts, breaches and the median first-response time from live rows', async () => {
    const stats = await withTenant(t.db, ws.ctx('agent'), (tx) => getDashboard(tx, clock.now()));
    expect(stats.byStatus).toEqual({ open: 4, pending: 1, resolved: 0, closed: 0 });
    expect(stats.openByPriority.normal).toBe(5);
    expect(stats.unassignedOpen).toBe(5);
    expect(stats.medianFirstResponseSeconds).toBe(30 * 60);
    expect(stats.respondedLast30Days).toBe(3);
    // The two unanswered tickets missed their 8-hour first-response target.
    expect(stats.breachesLast7Days).toBe(2);
    expect(stats.activeTicketsInBreach).toBe(2);
    expect(stats.recentBreaches).toHaveLength(2);
  });

  it('reports no median when nothing has been answered', async () => {
    const empty = await createWorkspace(t.db, 'dash-empty');
    const stats = await withTenant(t.db, empty.ctx('agent'), (tx) => getDashboard(tx, clock.now()));
    expect(stats.medianFirstResponseSeconds).toBeNull();
    expect(stats.byStatus.open).toBe(0);
  });
});
