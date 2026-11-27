import { sql } from 'kysely';
import { z } from 'zod';
import type { TenantTx } from '../db/tenant';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors';
import { authorize, authorizeRoleChange } from '../domain/rbac';
import { ROLES } from '../domain/types';
import { recordAudit } from '../repositories/audit';
import { findMember, listMembers } from '../repositories/members';

export const roleChangeInput = z.object({ userId: z.uuid(), role: z.enum(ROLES) });

export async function getMembers(tx: TenantTx) {
  authorize(tx.ctx.actor, 'members:read');
  return listMembers(tx);
}

export async function changeMemberRole(tx: TenantTx, raw: unknown) {
  const parsed = roleChangeInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid role change');
  const { userId, role } = parsed.data;
  authorize(tx.ctx.actor, 'members:manage');

  // Serialise role changes per workspace so the last-owner check cannot race.
  await sql`select 1 from memberships where workspace_id = ${tx.workspaceId} for update`.execute(
    tx.db,
  );
  const member = await findMember(tx, userId);
  if (!member) throw new NotFoundError('Member');
  authorizeRoleChange(tx.ctx.actor, member.role, role);
  if (member.role === role) return { changed: false };

  if (member.role === 'owner') {
    const owners = await tx.db
      .selectFrom('memberships')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('workspaceId', '=', tx.workspaceId)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow();
    if (owners.n <= 1) throw new ConflictError('A workspace must keep at least one owner');
  }

  await tx.db
    .updateTable('memberships')
    .set({ role })
    .where('workspaceId', '=', tx.workspaceId)
    .where('userId', '=', userId)
    .execute();
  await recordAudit(tx, {
    action: 'member.role_changed',
    data: { userId, name: member.name, from: member.role, to: role },
  });
  return { changed: true };
}
