import 'server-only';
import { requireApiSession, tenantContext } from './auth/current';
import type { SessionUser } from './auth/sessions';
import { getContainer } from './container';
import { withTenant, type TenantTx } from './db/tenant';
import { DomainError } from './domain/errors';
import type { ServiceDeps } from './services/deps';

export interface ActionState {
  readonly ok?: boolean;
  readonly error?: string;
  /** Changes on every result so clients can react to repeated successes. */
  readonly at?: number;
}

/**
 * The one way server actions touch tenant data: authenticate, open a
 * tenant-scoped transaction, run the service, and turn domain errors into a
 * message for the form. Unexpected errors are logged and reported generically.
 */
export async function runTenantAction(
  fn: (tx: TenantTx, deps: ServiceDeps, session: SessionUser) => Promise<unknown>,
): Promise<ActionState> {
  try {
    const session = await requireApiSession();
    const { db, deps } = await getContainer();
    await withTenant(db, tenantContext(session), (tx) => fn(tx, deps, session));
    return { ok: true, at: Date.now() };
  } catch (error) {
    if (error instanceof DomainError) return { error: error.message, at: Date.now() };
    console.error('server action failed', error);
    return { error: 'Something went wrong. Please try again.', at: Date.now() };
  }
}
