import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/server/db/tenant';
import { NotFoundError, ValidationError } from '../../src/server/domain/errors';
import { listMembers } from '../../src/server/repositories/members';
import { findTicket, listMessages } from '../../src/server/repositories/tickets';
import { getDashboard } from '../../src/server/services/dashboard';
import {
  assignTicket,
  changeStatus,
  getInbox,
  getTicketView,
  replyToTicket,
} from '../../src/server/services/tickets';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
  createTicket,
  createWorkspace,
  makeDeps,
  type WorkspaceFixture,
} from '../helpers/fixtures';

describe('tenant isolation', () => {
  let t: TestDatabase;
  let acme: WorkspaceFixture;
  let globex: WorkspaceFixture;
  let acmeTicket: { ticketId: string };
  let globexTicket: { ticketId: string };
  const { deps } = makeDeps();

  beforeAll(async () => {
    t = await createTestDatabase();
    acme = await createWorkspace(t.db, 'acme');
    globex = await createWorkspace(t.db, 'globex');
    acmeTicket = await createTicket(t.db, deps, acme, {
      subject: 'Acme printer on fire',
      text: 'acme secret',
    });
    globexTicket = await createTicket(t.db, deps, globex, {
      subject: 'Globex merger docs',
      text: 'globex secret',
    });
  });
  afterAll(() => t.destroy());

  it('row-level security hides other workspaces even from unfiltered SQL', async () => {
    const rows = await withTenant(t.db, acme.ctx('agent'), async (tx) => ({
      tickets: (await sql<{ id: string }>`select id from tickets`.execute(tx.db)).rows,
      messages: (await sql<{ body: string }>`select body from messages`.execute(tx.db)).rows,
      customers: (await sql<{ id: string }>`select id from customers`.execute(tx.db)).rows,
      audit: (await sql<{ id: string }>`select workspace_id from audit_events`.execute(tx.db)).rows,
      workspaces: (await sql<{ slug: string }>`select slug from workspaces`.execute(tx.db)).rows,
    }));
    expect(rows.tickets.map((r) => r.id)).toEqual([acmeTicket.ticketId]);
    expect(rows.messages.map((r) => r.body)).toEqual(['acme secret']);
    expect(rows.customers).toHaveLength(1);
    expect(rows.audit.length).toBeGreaterThan(0);
    expect(rows.workspaces.map((r) => r.slug)).toEqual(['acme']);
  });

  it('only exposes users who are members of the current workspace', async () => {
    const members = await withTenant(t.db, acme.ctx('agent'), (tx) => listMembers(tx));
    expect(members.map((m) => m.email).sort()).toEqual([
      'admin@acme.test',
      'agent@acme.test',
      'owner@acme.test',
    ]);
    const raw = await withTenant(t.db, acme.ctx('agent'), (tx) =>
      sql<{ email: string }>`select email from users`.execute(tx.db),
    );
    expect(raw.rows.every((r) => r.email.endsWith('@acme.test'))).toBe(true);
  });

  it('never lets tenant code read password hashes', async () => {
    await expect(
      withTenant(t.db, acme.ctx('owner'), (tx) =>
        sql`select password_hash from users`.execute(tx.db),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('treats another workspace’s ticket id as not found', async () => {
    const found = await withTenant(t.db, acme.ctx('owner'), (tx) =>
      findTicket(tx, globexTicket.ticketId),
    );
    expect(found).toBeNull();
    await expect(
      withTenant(t.db, acme.ctx('owner'), (tx) => getTicketView(tx, globexTicket.ticketId)),
    ).rejects.toBeInstanceOf(NotFoundError);
    const messages = await withTenant(t.db, acme.ctx('owner'), (tx) =>
      listMessages(tx, globexTicket.ticketId),
    );
    expect(messages).toEqual([]);
  });

  it('cannot reply to, or change, a ticket in another workspace', async () => {
    await expect(
      withTenant(t.db, acme.ctx('owner'), (tx) =>
        replyToTicket(tx, deps, { ticketId: globexTicket.ticketId, body: 'pwned' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      withTenant(t.db, acme.ctx('owner'), (tx) =>
        changeStatus(tx, deps, { ticketId: globexTicket.ticketId, status: 'closed' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const untouched = await withTenant(t.db, globex.ctx('owner'), (tx) =>
      findTicket(tx, globexTicket.ticketId),
    );
    expect(untouched?.status).toBe('open');
  });

  it('cannot assign a ticket to a user from another workspace', async () => {
    await expect(
      withTenant(t.db, acme.ctx('admin'), (tx) =>
        assignTicket(tx, deps, {
          ticketId: acmeTicket.ticketId,
          assigneeId: globex.users.agent.id,
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects writes that name another workspace, at the database level', async () => {
    await expect(
      withTenant(t.db, acme.ctx('owner'), (tx) =>
        sql`insert into customers (workspace_id, email) values (${globex.id}, 'x@evil.test')`.execute(
          tx.db,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await withTenant(t.db, acme.ctx('owner'), (tx) =>
      sql`update tickets set subject = 'hijacked' where id = ${globexTicket.ticketId}`.execute(
        tx.db,
      ),
    );
    expect(Number(updated.numAffectedRows ?? 0)).toBe(0);
  });

  it('keeps the audit log append-only for tenant code', async () => {
    await expect(
      withTenant(t.db, acme.ctx('owner'), (tx) => sql`delete from audit_events`.execute(tx.db)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(t.db, acme.ctx('owner'), (tx) =>
        sql`update audit_events set action = 'x'`.execute(tx.db),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('scopes search and the dashboard to the workspace', async () => {
    const page = await withTenant(t.db, acme.ctx('agent'), (tx) => getInbox(tx, { q: 'merger' }));
    expect(page.items).toEqual([]);
    const own = await withTenant(t.db, acme.ctx('agent'), (tx) => getInbox(tx, { q: 'printer' }));
    expect(own.items.map((i) => i.id)).toEqual([acmeTicket.ticketId]);
    const stats = await withTenant(t.db, globex.ctx('agent'), (tx) => getDashboard(tx, new Date()));
    expect(stats.byStatus.open).toBe(1);
  });

  it('does not leak the tenant role or workspace past the transaction', async () => {
    await withTenant(t.db, acme.ctx('agent'), async () => undefined);
    const after = await sql<{ role: string; ws: string | null }>`
      select current_user as role, nullif(current_setting('app.workspace_id', true), '') as ws
    `.execute(t.db);
    expect(after.rows[0]?.role).not.toBe('deskline_app');
    expect(after.rows[0]?.ws).toBeNull();
  });

  it('refuses a malformed workspace id before touching the database', async () => {
    await expect(
      withTenant(
        t.db,
        { workspaceId: "x' or 1=1 --", actor: { kind: 'system', name: 't' } },
        async () => 1,
      ),
    ).rejects.toThrow(/UUID/);
  });
});
