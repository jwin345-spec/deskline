import type { TenantTx } from '../db/tenant';
import type { Role } from '../domain/types';

export interface Member {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly joinedAt: Date;
}

export async function listMembers(tx: TenantTx): Promise<Member[]> {
  return tx.db
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.userId')
    .select(['u.id as userId', 'u.name', 'u.email', 'm.role', 'm.createdAt as joinedAt'])
    .where('m.workspaceId', '=', tx.workspaceId)
    .orderBy('u.name')
    .execute();
}

export async function findMember(tx: TenantTx, userId: string): Promise<Member | null> {
  const row = await tx.db
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.userId')
    .select(['u.id as userId', 'u.name', 'u.email', 'm.role', 'm.createdAt as joinedAt'])
    .where('m.workspaceId', '=', tx.workspaceId)
    .where('m.userId', '=', userId)
    .executeTakeFirst();
  return row ?? null;
}
