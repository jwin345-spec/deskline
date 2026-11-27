import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Kysely, sql } from 'kysely';
import {
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
  Migrator,
} from 'kysely/migration';

/** `migrations/` at the project root (the working directory of every entry point). */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Loads forward-only, plain-SQL migrations named `NNNN_description.sql`.
 * SQL files keep the schema reviewable by DBAs and portable to other tools;
 * Kysely's Migrator supplies ordering, bookkeeping and an advisory lock so
 * concurrent deploys cannot apply the same migration twice.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  readonly #directory: string;

  constructor(directory: string = DEFAULT_MIGRATIONS_DIR) {
    this.#directory = directory;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.#directory)).filter((file) => file.endsWith('.sql')).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      if (!MIGRATION_FILE.test(file)) {
        throw new Error(`Migration file name "${file}" must match ${MIGRATION_FILE.source}`);
      }
      const statements = await readFile(path.join(this.#directory, file), 'utf8');
      migrations[file.replace(/\.sql$/, '')] = {
        up: async (db: Kysely<unknown>) => {
          await sql.raw(statements).execute(db);
        },
      };
    }
    return migrations;
  }
}

export interface MigrateOptions {
  readonly directory?: string;
  /** Schema holding Kysely's bookkeeping tables; defaults to the search_path. */
  readonly schema?: string;
}

export async function migrateToLatest(
  // Migrations are schema-agnostic; accept a Kysely instance of any database type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  options: MigrateOptions = {},
): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(options.directory),
    ...(options.schema === undefined ? {} : { migrationTableSchema: options.schema }),
  });
  const resultSet = await migrator.migrateToLatest();
  if (resultSet.error) {
    throw resultSet.error instanceof Error
      ? resultSet.error
      : new Error('Migration failed', { cause: resultSet.error });
  }
  return resultSet;
}
