// Health route.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { makeConfig, tempDir } from './helpers.js';

describe('GET /api/health', () => {
  it('responds 200 { status: ok }', async () => {
    const app = buildApp(makeConfig(tempDir()));
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });
});
