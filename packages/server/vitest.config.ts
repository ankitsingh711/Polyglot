import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Each file gets its own process: the database module and the provider
    // registry are module-level singletons, and sharing them across files would
    // make test order matter.
    pool: 'forks',
    isolate: true,
    testTimeout: 15_000,
  },
});
