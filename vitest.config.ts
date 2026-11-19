import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Scope vitest to the workspace test suites (server + web). The root legacy
// node:test suites (test/*.test.mjs) are run by `node --test` and must not be
// swept here. Web tests needing a DOM declare it per-file via
// @vitest-environment jsdom.
//
// `silent: 'passed-only'`: the suites deliberately exercise production code
// whose log lines are expected output (wake/dedup notices, subscriber and
// payload failure paths, malformed-fixture notices, stream-reconnect logs), so
// passing tests do not bleed console output into the gate. A FAILING test
// still prints its logs.
export default defineConfig({
  // Component tests use JSX; the Next tsconfig's `preserve` mode is not what
  // esbuild needs here.
  esbuild: { jsx: 'automatic' },
  resolve: {
    // The web workspace's `@/*` alias (web/tsconfig.json paths).
    alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) },
  },
  test: {
    include: [
      'server/test/**/*.test.ts',
      'web/test/**/*.test.ts',
      'web/test/**/*.test.tsx',
    ],
    environment: 'node',
    testTimeout: 15_000,
    silent: 'passed-only',
    setupFiles: ['web/test/setup-dom.ts'],
  },
});
