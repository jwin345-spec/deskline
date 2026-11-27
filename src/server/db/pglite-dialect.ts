import type { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

/**
 * Minimal Kysely dialect for PGlite (Postgres compiled to WASM).
 *
 * PGlite is a single-session database, so the driver hands out one logical
 * connection at a time behind a FIFO mutex. Concurrent requests therefore
 * queue rather than interleave, which is exactly the semantics a test or a
 * local dev server needs. Real concurrency behaviour is exercised against a
 * Postgres server in CI (see TEST_DATABASE_URL).
 */
export class PGliteDialect implements Dialect {
  readonly #client: PGlite;

  constructor(client: PGlite) {
    this.#client = client;
  }

  createDriver(): Driver {
    return new PGliteDriver(this.#client);
  }

  createQueryCompiler() {
    return new PostgresQueryCompiler();
  }

  createAdapter() {
    return new PostgresAdapter();
  }

  createIntrospector(db: Kysely<unknown>) {
    return new PostgresIntrospector(db);
  }
}

class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => released);
    await previous;
    return release;
  }
}

class PGliteDriver implements Driver {
  readonly #client: PGlite;
  readonly #mutex = new Mutex();

  constructor(client: PGlite) {
    this.#client = client;
  }

  async init(): Promise<void> {
    await this.#client.waitReady;
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const release = await this.#mutex.acquire();
    return new PGliteConnection(this.#client, release);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const parts = ['start transaction'];
    if (settings.isolationLevel) {
      parts.push(`isolation level ${settings.isolationLevel}`);
    }
    if (settings.accessMode) {
      parts.push(settings.accessMode);
    }
    await connection.executeQuery(CompiledQuery.raw(parts.join(' ')));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    (connection as PGliteConnection).release();
  }

  async destroy(): Promise<void> {
    if (!this.#client.closed) {
      await this.#client.close();
    }
  }
}

class PGliteConnection implements DatabaseConnection {
  readonly #client: PGlite;
  readonly release: () => void;

  constructor(client: PGlite, release: () => void) {
    this.#client = client;
    this.release = release;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;

    // Parameterless statements go through the simple query protocol so that
    // multi-statement scripts (migrations) work, mirroring node-postgres.
    if (parameters.length === 0) {
      const results = await this.#client.exec(sql);
      const last = results.at(-1);
      return {
        rows: (last?.rows ?? []) as R[],
        ...(last?.affectedRows === undefined ? {} : { numAffectedRows: BigInt(last.affectedRows) }),
      };
    }

    const result = await this.#client.query<R>(sql, [...parameters]);
    return {
      rows: result.rows,
      ...(result.affectedRows === undefined
        ? {}
        : { numAffectedRows: BigInt(result.affectedRows) }),
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('PGliteDialect does not support streaming queries');
  }
}
