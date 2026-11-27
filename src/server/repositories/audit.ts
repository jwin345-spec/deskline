import type { TenantTx } from '../db/tenant';

export interface AuditInput {
  readonly ticketId?: string | null;
  readonly action: string;
  readonly data?: Record<string, unknown>;
  /** Defaults to the transaction's actor. */
  readonly actorType?: 'user' | 'customer' | 'system';
  /** The service clock's time; defaults to the database's now(). */
  readonly at?: Date;
}

/** Appends to the audit log inside the caller's transaction (atomic with the change). */
export async function recordAudit(tx: TenantTx, input: AuditInput): Promise<void> {
  const actor = tx.ctx.actor;
  await tx.db
    .insertInto('auditEvents')
    .values({
      workspaceId: tx.workspaceId,
      ticketId: input.ticketId ?? null,
      actorType: input.actorType ?? (actor.kind === 'user' ? 'user' : 'system'),
      actorUserId: actor.kind === 'user' ? actor.userId : null,
      action: input.action,
      ...(input.at ? { createdAt: input.at } : {}),
      data: JSON.stringify({
        ...(actor.kind === 'system' ? { system: actor.name } : {}),
        ...input.data,
      }),
    })
    .execute();
}

export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly actorType: 'user' | 'customer' | 'system';
  readonly actorName: string | null;
  readonly data: Record<string, unknown>;
  readonly createdAt: Date;
}

export async function listTicketAudit(tx: TenantTx, ticketId: string): Promise<AuditEntry[]> {
  return tx.db
    .selectFrom('auditEvents as e')
    .leftJoin('users as u', 'u.id', 'e.actorUserId')
    .select(['e.id', 'e.action', 'e.actorType', 'u.name as actorName', 'e.data', 'e.createdAt'])
    .where('e.workspaceId', '=', tx.workspaceId)
    .where('e.ticketId', '=', ticketId)
    .orderBy('e.createdAt', 'desc')
    .orderBy('e.id')
    .limit(100)
    .execute();
}
