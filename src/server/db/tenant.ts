import { type Kysely, sql, type Transaction } from 'kysely';
import type { TenantContext } from '../domain/types';
import type { Db } from './database';
import type { Database } from './schema';

/** The role tenant transactions run as. Subject to row-level security. */
export const TENANT_ROLE = 'deskline_app';

/**
 * A transaction bound to one workspace. Repositories only accept this type,
 * so tenant data cannot be read through an unscoped connection by accident.
 */
export interface TenantTx {
  readonly db: Transaction<Database>;
  readonly ctx: TenantContext;
  readonly workspaceId: string;
  /** Runs after a successful COMMIT (e.g. publishing real-time events). */
  afterCommit(fn: () => void): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenancy boundary. Opens a transaction, drops privileges to the
 * `deskline_app` role and pins `app.workspace_id`, so Postgres row-level
 * security confines every statement to the caller's workspace. Repositories
 * add explicit `workspace_id` predicates on top (defence in depth, and they
 * keep the planner on the composite indexes).
 *
 * Both settings are `LOCAL`, so they end with the transaction and can never
 * leak to the next user of a pooled connection.
 */
export async function withTenant<T>(
  db: Db | Kysely<Database>,
  ctx: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(ctx.workspaceId)) {
    throw new Error('withTenant: workspaceId must be a UUID');
  }
  const callbacks: (() => void)[] = [];
  const result = await db.transaction().execute(async (trx) => {
    await sql`select set_config('role', ${TENANT_ROLE}, true), set_config('app.workspace_id', ${ctx.workspaceId}, true)`.execute(
      trx,
    );
    return fn({
      db: trx,
      ctx,
      workspaceId: ctx.workspaceId,
      afterCommit: (cb) => callbacks.push(cb),
    });
  });
  for (const cb of callbacks) {
    try {
      cb();
    } catch (error) {
      console.error('afterCommit callback failed', error);
    }
  }
  return result;
}
