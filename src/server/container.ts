import 'server-only';
import { loadConfig } from './config';
import { createDatabase, type Db } from './db/database';
import { migrateToLatest } from './db/migrator';
import { RealtimeBroker } from './realtime/broker';
import { PresenceRegistry } from './realtime/presence';
import { createReplyDrafter, type ReplyDrafter } from './services/ai-reply';
import type { ServiceDeps } from './services/deps';
import { JobWorker } from './services/sla-worker';

interface Container {
  readonly db: Db;
  readonly deps: ServiceDeps;
  readonly broker: RealtimeBroker;
  readonly presence: PresenceRegistry;
  readonly drafter: ReplyDrafter | null;
  readonly worker: JobWorker | null;
}

/**
 * Process-wide singletons. Kept on globalThis because Next.js may evaluate
 * this module more than once (route handlers, server actions, dev HMR), and a
 * second PGlite instance on the same data directory, or a second event bus,
 * would silently split state.
 */
const globalForContainer = globalThis as unknown as { __deskline?: Promise<Container> };

async function build(): Promise<Container> {
  const config = loadConfig();
  const db = await createDatabase({ url: config.DATABASE_URL });
  const migrateOnStart = config.MIGRATE_ON_START ?? config.DATABASE_URL.startsWith('pglite:');
  if (migrateOnStart) {
    await migrateToLatest(db);
  }
  const broker = new RealtimeBroker();
  const presence = new PresenceRegistry(broker);
  const deps: ServiceDeps = { broker, now: () => new Date() };
  const worker = config.SLA_WORKER_ENABLED
    ? new JobWorker(db, deps, { pollMs: config.SLA_WORKER_POLL_MS })
    : null;
  worker?.start();
  return { db, deps, broker, presence, drafter: createReplyDrafter(), worker };
}

export function getContainer(): Promise<Container> {
  globalForContainer.__deskline ??= build().catch((error: unknown) => {
    globalForContainer.__deskline = undefined;
    throw error;
  });
  return globalForContainer.__deskline;
}

export function aiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}
