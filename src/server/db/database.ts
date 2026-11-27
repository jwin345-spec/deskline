import { mkdir } from 'node:fs/promises';
import { CamelCasePlugin, type Dialect, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

export type Db = Kysely<Database>;

export interface DatabaseOptions {
  /** `postgres://...`, `pglite:memory` or `pglite:<data directory>`. */
  readonly url: string;
  readonly poolMax?: number;
  /** Overrides search_path; used to isolate test runs in their own schema. */
  readonly searchPath?: string;
}

function createPostgresDialect(options: DatabaseOptions): Dialect {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax ?? 10,
    statement_timeout: 10_000,
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });
  pool.on('error', (error) => console.error('postgres pool error', error));
  return new PostgresDialect({ pool });
}

async function createPGliteDialect(url: string): Promise<Dialect> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGliteDialect } = await import('./pglite-dialect');
  const location = url.slice('pglite:'.length);
  const inMemory = location === 'memory' || location === '';
  if (!inMemory) {
    await mkdir(location, { recursive: true });
  }
  const client = new PGlite(inMemory ? {} : { dataDir: location });
  return new PGliteDialect(client);
}

export async function createDatabase(options: DatabaseOptions): Promise<Db> {
  const dialect = options.url.startsWith('pglite:')
    ? await createPGliteDialect(options.url)
    : createPostgresDialect(options);
  return new Kysely<Database>({ dialect, plugins: [new CamelCasePlugin()] });
}
