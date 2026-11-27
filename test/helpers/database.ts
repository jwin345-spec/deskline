import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabase, type Db } from '../../src/server/db/database';
import { migrateToLatest } from '../../src/server/db/migrator';

export interface TestDatabase {
  readonly db: Db;
  readonly backend: 'pglite' | 'postgres';
  destroy(): Promise<void>;
}

/**
 * A fresh, fully migrated database per test file: in-memory PGlite by default
 * (no Docker), or a throwaway schema on a real server when TEST_DATABASE_URL
 * is set (CI runs both).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const db = await createDatabase({ url: 'pglite:memory' });
    await migrateToLatest(db);
    return { db, backend: 'pglite', destroy: () => db.destroy() };
  }

  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = await createDatabase({ url, poolMax: 1 });
  await sql`create schema ${sql.id(schema)}`.execute(admin);
  const db = await createDatabase({ url, poolMax: 10, searchPath: schema });
  await migrateToLatest(db);
  return {
    db,
    backend: 'postgres',
    destroy: async () => {
      await db.destroy();
      await sql`drop schema ${sql.id(schema)} cascade`.execute(admin);
      await admin.destroy();
    },
  };
}
