import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI);
const PORT = 3100;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * E2E runs against the production build (`npm run build` first) backed by a
 * freshly seeded PGlite database, so no Docker or external services are needed.
 * Tests share that one seeded workspace, so they run in a single worker and
 * each one works on its own tickets.
 */
export default defineConfig({
  testDir: './e2e',
  testIgnore: ['screenshots/**'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Optional: run against an installed browser instead of the bundled one,
        // e.g. PLAYWRIGHT_CHANNEL=chrome or msedge.
        ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
  webServer: {
    command: `npx tsx scripts/seed.ts --reset && npx next start -H 127.0.0.1 -p ${PORT}`,
    url: `${BASE_URL}/api/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: 'pglite:./.data/e2e',
      SLA_WORKER_POLL_MS: '500',
      // The AI feature must be off in E2E: no network calls, and the disabled state is under test.
      ANTHROPIC_API_KEY: '',
    },
  },
});
