import { loadConfig } from '../src/server/config';
import { createDatabase } from '../src/server/db/database';
import { migrateToLatest } from '../src/server/db/migrator';

const config = loadConfig();
const db = await createDatabase({ url: config.DATABASE_URL });
try {
  const { results = [] } = await migrateToLatest(db);
  for (const result of results) {
    console.log(`${result.status.padEnd(7)} ${result.migrationName}`);
  }
  console.log(
    results.length === 0
      ? 'Database is already up to date.'
      : `Applied ${results.length} migration(s).`,
  );
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
