import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/database';
import type { Role } from '../domain/types';
import { getDummyHash, verifyPassword } from './password';

export const SESSION_COOKIE = 'deskline_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  readonly role: Role;
  readonly expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Checks credentials and returns the user plus their first workspace, or null.
 * Unknown emails still cost one scrypt verification (constant-ish timing).
 */
export async function authenticate(
  db: Db,
  email: string,
  password: string,
): Promise<{ userId: string; workspaceId: string } | null> {
  const user = await db
    .selectFrom('users')
    .select(['id', 'passwordHash'])
    .where((eb) => eb(eb.fn('lower', ['email']), '=', email.trim().toLowerCase()))
    .executeTakeFirst();
  const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !ok) return null;

  const membership = await db
    .selectFrom('memberships')
    .select('workspaceId')
    .where('userId', '=', user.id)
    .orderBy('createdAt')
    .executeTakeFirst();
  if (!membership) return null;
  return { userId: user.id, workspaceId: membership.workspaceId };
}

/** Creates a session and returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(
  db: Db,
  userId: string,
  workspaceId: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db
    .insertInto('sessions')
    .values({ id: hashToken(token), userId, workspaceId, expiresAt, createdAt: now })
    .execute();
  return { token, expiresAt };
}

/**
 * Resolves a cookie token to a session. The membership join means a user
 * removed from a workspace loses access on their very next request.
 */
export async function validateSession(
  db: Db,
  token: string,
  now = new Date(),
): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const row = await db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.userId')
    .innerJoin('memberships as m', (join) =>
      join.onRef('m.userId', '=', 's.userId').onRef('m.workspaceId', '=', 's.workspaceId'),
    )
    .innerJoin('workspaces as w', 'w.id', 's.workspaceId')
    .select([
      's.id as sessionId',
      's.expiresAt',
      'u.id as userId',
      'u.email',
      'u.name',
      'w.id as workspaceId',
      'w.name as workspaceName',
      'w.slug as workspaceSlug',
      'm.role',
    ])
    .where('s.id', '=', hashToken(token))
    .executeTakeFirst();
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.deleteFrom('sessions').where('id', '=', row.sessionId).execute();
    return null;
  }
  return row;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.deleteFrom('sessions').where('id', '=', hashToken(token)).execute();
}
