import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** `npm run screenshots`: regenerates docs/screenshots from the running app. */
export default defineConfig({
  ...base,
  testDir: './e2e/screenshots',
  testIgnore: [],
  retries: 0,
  reporter: 'list',
  projects: [
    {
      name: 'screenshots',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
});
