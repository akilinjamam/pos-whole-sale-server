import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Integration tests: they need a real MongoDB **replica set** (MONGODB_URI in .env), so they are
 * kept out of `npm test` / `npm run verify`, which must pass on any machine with no database.
 *
 *   npm run test:integration
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.int.test.ts'],
    pool: 'forks',
    // One file at a time: they share a database, and parallel files would only add noise to the
    // concurrency each test creates deliberately.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
