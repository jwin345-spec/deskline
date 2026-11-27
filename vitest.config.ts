import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // Next's `server-only` guard throws outside a React Server bundle.
      'server-only': path.resolve(import.meta.dirname, 'test/helpers/server-only.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each integration file boots its own embedded Postgres (PGlite) and migrates it.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
