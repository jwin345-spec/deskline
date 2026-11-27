import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/server/db/tenant';
import { decodeCursor } from '../../src/server/lib/cursor';
import {
  addInternalNote,
  assignTicket,
  changeStatus,
  getInbox,
} from '../../src/server/services/tickets';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
  createTicket,
  createWorkspace,
  makeDeps,
  type WorkspaceFixture,
} from '../helpers/fixtures';

describe('inbox search, filters and pagination', () => {
  let t: TestDatabase;
  let ws: WorkspaceFixture;
  const { deps, clock } = makeDeps();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDatabase();
    ws = await createWorkspace(t.db, 'search');
    const seeds = [
      [
        'refund',
        'Refund request for order 991',
        'I was charged twice and would like refunds for both.',
      ],
      ['sso', 'Cannot sign in with SSO', 'Okta says invalid audience when our team logs in.'],
      ['export', 'Export tickets to CSV', 'How can I export everything for compliance?'],
      ['webhook', 'Webhooks delayed', 'Deliveries arrive ten minutes late.'],
    ] as const;
    for (const [key, subject, text] of seeds) {
      clock.advance(60_000);
      ids[key] = (
        await createTicket(t.db, deps, ws, { subject, text, from: `${key}@customer.example` })
      ).ticketId;
    }
    await withTenant(t.db, ws.ctx('agent'), async (tx) => {
      await addInternalNote(tx, deps, {
        ticketId: ids.export!,
        body: 'Customer is on the zeppelin plan',
      });
      await assignTicket(tx, deps, { ticketId: ids.sso!, assigneeId: ws.users.agent.id });
      await changeStatus(tx, deps, { ticketId: ids.webhook!, status: 'resolved' });
    });
  });
  afterAll(() => t.destroy());

  const search = (filters: Parameters<typeof getInbox>[1]) =>
    withTenant(t.db, ws.ctx('agent'), (tx) => getInbox(tx, filters));

  it('matches message bodies with English stemming', async () => {
    const page = await search({ q: 'charge refund' });
    expect(page.items.map((i) => i.id)).toEqual([ids.refund]);
  });

  it('matches subjects and supports web-style query syntax', async () => {
    expect((await search({ q: '"invalid audience"' })).items.map((i) => i.id)).toEqual([ids.sso]);
    expect((await search({ q: 'export -compliance' })).items).toEqual([]);
  });

  it('finds tickets by number and by exact customer email', async () => {
    const first = await search({ q: '#1' });
    expect(first.items.map((i) => i.number)).toEqual([1]);
    expect((await search({ q: 'SSO@customer.example' })).items.map((i) => i.id)).toEqual([ids.sso]);
  });

  it('never matches internal notes', async () => {
    expect((await search({ q: 'zeppelin' })).items).toEqual([]);
  });

  it('filters by status, assignee and priority', async () => {
    expect((await search({ status: 'resolved' })).items.map((i) => i.id)).toEqual([ids.webhook]);
    expect((await search({ status: 'active' })).items).toHaveLength(3);
    expect((await search({ assignee: 'me' })).items.map((i) => i.id)).toEqual([ids.sso]);
    expect((await search({ assignee: 'unassigned', status: 'active' })).items).toHaveLength(2);
    expect((await search({ priority: 'urgent' })).items).toEqual([]);
  });

  it('paginates with a keyset cursor without gaps or duplicates, even as new tickets arrive', async () => {
    for (let i = 0; i < 7; i++) {
      clock.advance(1000);
      await createTicket(t.db, deps, ws, { subject: `Bulk ticket ${i}` });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await search({ cursor: decodeCursor(cursor), limit: 3 });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
      if (pages === 2) {
        // A ticket arriving mid-scroll lands on page one and must not shift later pages.
        clock.advance(1000);
        await createTicket(t.db, deps, ws, { subject: 'Arrived while paginating' });
      }
    } while (cursor);
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
    expect(pages).toBe(4);
  });

  it('ignores a forged or corrupt cursor', () => {
    expect(decodeCursor('not-base64-json')).toBeNull();
    expect(
      decodeCursor(Buffer.from('{"t":"x","i":"not-a-uuid"}').toString('base64url')),
    ).toBeNull();
  });
});
