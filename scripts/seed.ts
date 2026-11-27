import { loadConfig } from '../src/server/config';
import { createDatabase } from '../src/server/db/database';
import { migrateToLatest } from '../src/server/db/migrator';
import { DEMO_PASSWORD, DEMO_USERS, isSeeded, resetData, seedDemoData } from '../src/server/seed';

const reset = process.argv.includes('--reset');
const config = loadConfig();
const db = await createDatabase({ url: config.DATABASE_URL });
try {
  await migrateToLatest(db);
  if (reset) {
    await resetData(db);
    console.log('Cleared existing data.');
  }
  if (await isSeeded(db)) {
    console.log('Demo data already present; run `npm run db:reset` to start over.');
  } else {
    await seedDemoData(db);
    console.log('Seeded demo workspaces. Sign in with any of:');
    for (const user of DEMO_USERS) {
      console.log(`  ${user.email.padEnd(20)} ${user.role.padEnd(6)} (${user.workspace})`);
    }
    console.log(`Password for all demo users: ${DEMO_PASSWORD}`);
  }
} catch (error) {
  console.error('Seeding failed:', error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
