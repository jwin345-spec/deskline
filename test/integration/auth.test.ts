import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/server/auth/password';
import {
  authenticate,
  createSession,
  deleteSession,
  SESSION_TTL_MS,
  validateSession,
} from '../../src/server/auth/sessions';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createWorkspace, type WorkspaceFixture } from '../helpers/fixtures';

describe('passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('wrong horse', a)).toBe(false);
  });

  it('rejects malformed hashes', async () => {
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
  });
});

describe('sessions', () => {
  let t: TestDatabase;
  let ws: WorkspaceFixture;

  beforeAll(async () => {
    t = await createTestDatabase();
    ws = await createWorkspace(t.db, 'auth');
    await t.db
      .updateTable('users')
      .set({ passwordHash: await hashPassword('s3cret-pass') })
      .where('id', '=', ws.users.agent.id)
      .execute();
  });
  afterAll(() => t.destroy());

  it('authenticates by case-insensitive email and correct password only', async () => {
    expect(await authenticate(t.db, 'AGENT@auth.test', 's3cret-pass')).toEqual({
      userId: ws.users.agent.id,
      workspaceId: ws.id,
    });
    expect(await authenticate(t.db, 'agent@auth.test', 'nope')).toBeNull();
    expect(await authenticate(t.db, 'ghost@auth.test', 's3cret-pass')).toBeNull();
  });

  it('stores only a hash of the session token', async () => {
    const { token } = await createSession(t.db, ws.users.agent.id, ws.id);
    const stored = await t.db.selectFrom('sessions').select('id').execute();
    expect(stored.map((s) => s.id)).not.toContain(token);
    expect(stored.every((s) => /^[0-9a-f]{64}$/.test(s.id))).toBe(true);
  });

  it('resolves a valid token to the user, workspace and role', async () => {
    const { token } = await createSession(t.db, ws.users.agent.id, ws.id);
    expect(await validateSession(t.db, token)).toMatchObject({
      userId: ws.users.agent.id,
      workspaceId: ws.id,
      role: 'agent',
      email: 'agent@auth.test',
    });
    expect(await validateSession(t.db, `${token}x`)).toBeNull();
  });

  it('expires sessions and supports logout', async () => {
    const now = new Date();
    const { token } = await createSession(t.db, ws.users.agent.id, ws.id, now);
    expect(
      await validateSession(t.db, token, new Date(now.getTime() + SESSION_TTL_MS + 1)),
    ).toBeNull();
    const second = await createSession(t.db, ws.users.agent.id, ws.id);
    await deleteSession(t.db, second.token);
    expect(await validateSession(t.db, second.token)).toBeNull();
  });

  it('revokes access immediately when the membership is removed', async () => {
    const { token } = await createSession(t.db, ws.users.admin.id, ws.id);
    expect(await validateSession(t.db, token)).not.toBeNull();
    await t.db.deleteFrom('memberships').where('userId', '=', ws.users.admin.id).execute();
    expect(await validateSession(t.db, token)).toBeNull();
  });
});
