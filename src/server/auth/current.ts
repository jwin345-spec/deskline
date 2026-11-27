import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getContainer } from '../container';
import { ForbiddenError, UnauthenticatedError } from '../domain/errors';
import type { TenantContext } from '../domain/types';
import { SESSION_COOKIE, type SessionUser, validateSession } from './sessions';

/** The signed-in user for this request, memoised per render. */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const { db } = await getContainer();
  return validateSession(db, token);
});

/** For pages: redirect to the login screen when signed out. */
export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/** For server actions and route handlers: throw instead of redirecting. */
export async function requireApiSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new UnauthenticatedError();
  return session;
}

export function tenantContext(session: SessionUser): TenantContext {
  return {
    workspaceId: session.workspaceId,
    actor: { kind: 'user', userId: session.userId, role: session.role, name: session.name },
  };
}

/**
 * CSRF defence for cookie-authenticated route handlers. Server Actions get an
 * equivalent Origin/Host check from Next.js itself; plain route handlers do not,
 * so state-changing ones call this. SameSite=Lax cookies are the second layer.
 */
export async function assertSameOrigin(): Promise<void> {
  const h = await headers();
  const origin = h.get('origin');
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!origin || !host) throw new ForbiddenError('Cross-site request blocked');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ForbiddenError('Cross-site request blocked');
  }
  if (originHost !== host) throw new ForbiddenError('Cross-site request blocked');
}
