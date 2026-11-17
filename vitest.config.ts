import { defineConfig } from 'vitest/config';

// Scope vitest to the workspace test suites (server + web). The root legacy
// node:test suites (test/*.test.mjs) are run by `node --test` and must not be
// swept here. Web tests needing a DOM declare it per-file via
// @vitest-environment jsdom.
export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts', 'web/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
