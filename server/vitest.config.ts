import { defineConfig } from 'vitest/config';

// Same as the root workspace config (see ../../vitest.config.ts):
// `silent: 'passed-only'` keeps expected production log lines out of the gate
// output while a failing test still prints its logs.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    silent: 'passed-only',
  },
});
