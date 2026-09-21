import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `@shared/*` has to be declared here as well as in tsconfig.json. tsconfig `paths` teaches the
 * *typechecker* how to resolve the alias; Vite/vitest resolve modules themselves at runtime and
 * do not read it. Without this the tests fail on an unresolved import that `npm run typecheck`
 * is perfectly happy with.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Models register themselves with mongoose on import. Running files in parallel processes
    // is fine, but a shared process would hit "Cannot overwrite model once compiled".
    pool: 'forks',
  },
});
