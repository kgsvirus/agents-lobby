// Shared test helpers.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/infrastructure/config/index.js';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lobby-test-'));
}

/** Config for tests: temp db path, no auth file (or an explicit one). */
export const testDbPath = (dir: string): string => join(dir, 'test.db');

export function makeConfig(
  dir: string,
  env: Record<string, string> = {},
  authFile = join(dir, 'absent-auth.json'),
): AppConfig {
  return loadConfig({
    env: { ...env, LOBBY_DB_PATH: testDbPath(dir) },
    authFile,
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

