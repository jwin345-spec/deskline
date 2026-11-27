import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/server/db/tenant';
import { ConflictError, ForbiddenError } from '../../src/server/domain/errors';
import { findMember } from '../../src/server/repositories/members';
import { findTicket } from '../../src/server/repositories/tickets';
import { changeMemberRole } from '../../src/server/services/members';
import { assignTicket, changeStatus } from '../../src/server/services/tickets';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import {
  createTicket,
  createWorkspace,
  makeDeps,
  type WorkspaceFixture,
} from '../helpers/fixtures';

describe('RBAC enforced by services', () => {
  let t: TestDatabase;
  let ws: WorkspaceFixture;
  const { deps } = makeDeps();

  beforeAll(async () => {
    t = await createTestDatabase();
    ws = await createWorkspace(t.db, 'rbac');
  });
  afterAll(() => t.destroy());

  it('agents can claim a ticket but not hand it to someone else', async () => {
    const { ticketId } = await createTicket(t.db, deps, ws);
    await withTenant(t.db, ws.ctx('agent'), (tx) =>
      assignTicket(tx, deps, { ticketId, assigneeId: ws.users.agent.id }),
    );
    await expect(
      withTenant(t.db, ws.ctx('agent'), (tx) =>
        assignTicket(tx, deps, { ticketId, assigneeId: ws.users.admin.id }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const ticket = await withTenant(t.db, ws.ctx('agent'), (tx) => findTicket(tx, ticketId));
    expect(ticket?.assigneeId).toBe(ws.users.agent.id);
  });

  it('agents may still edit other fields of a ticket someone else owns', async () => {
    const { ticketId } = await createTicket(t.db, deps, ws);
    await withTenant(t.db, ws.ctx('admin'), (tx) =>
      assignTicket(tx, deps, { ticketId, assigneeId: ws.users.admin.id }),
    );
    // Re-submitting the same assignee alongside a status change is a no-op, not a reassignment.
    await withTenant(t.db, ws.ctx('agent'), async (tx) => {
      await changeStatus(tx, deps, { ticketId, status: 'pending' });
      await assignTicket(tx, deps, { ticketId, assigneeId: ws.users.admin.id });
    });
    const ticket = await withTenant(t.db, ws.ctx('agent'), (tx) => findTicket(tx, ticketId));
    expect(ticket?.status).toBe('pending');
  });

  it('agents cannot change roles; admins cannot touch owners', async () => {
    await expect(
      withTenant(t.db, ws.ctx('agent'), (tx) =>
        changeMemberRole(tx, { userId: ws.users.agent.id, role: 'admin' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      withTenant(t.db, ws.ctx('admin'), (tx) =>
        changeMemberRole(tx, { userId: ws.users.owner.id, role: 'agent' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      withTenant(t.db, ws.ctx('admin'), (tx) =>
        changeMemberRole(tx, { userId: ws.users.agent.id, role: 'owner' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('admins can promote an agent, and the change is audited', async () => {
    await withTenant(t.db, ws.ctx('admin'), (tx) =>
      changeMemberRole(tx, { userId: ws.users.agent.id, role: 'admin' }),
    );
    const member = await withTenant(t.db, ws.ctx('owner'), (tx) =>
      findMember(tx, ws.users.agent.id),
    );
    expect(member?.role).toBe('admin');
    const audit = await t.db
      .selectFrom('auditEvents')
      .select(['action', 'actorUserId'])
      .where('workspaceId', '=', ws.id)
      .where('action', '=', 'member.role_changed')
      .execute();
    expect(audit).toEqual([{ action: 'member.role_changed', actorUserId: ws.users.admin.id }]);
  });

  it('never demotes the last owner', async () => {
    await expect(
      withTenant(t.db, ws.ctx('owner'), (tx) =>
        changeMemberRole(tx, { userId: ws.users.owner.id, role: 'admin' }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
