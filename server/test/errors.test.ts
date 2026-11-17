// Global error handling → shared error envelope: AppError, zod, body limit,
// invalid JSON, opaque 500, 404.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/shared/errors/index.js';
import { makeConfig, tempDir } from './helpers.js';

interface Envelope {
  error: { code: string; message: string; details?: unknown };
}

describe('error envelope', () => {
  it('maps AppError to its status and code', async () => {
    const app = buildApp(makeConfig(tempDir()));
    app.post('/boom', async () => {
      throw new AppError(404, 'target_unknown', 'no such target');
    });
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: '/boom' });
      expect(res.statusCode).toBe(404);
      const body = res.json<Envelope>();
      expect(body.error.code).toBe('target_unknown');
      expect(body.error.message).toBe('no such target');
    } finally {
      await app.close();
    }
  });

  it('maps unexpected errors to an opaque 500 (internals logged, not sent)', async () => {
    const app = buildApp(makeConfig(tempDir()));
    app.post('/crash', async () => {
      throw new Error('SECRET-INTERNAL-DETAIL');
    });
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: '/crash' });
      expect(res.statusCode).toBe(500);
      const body = res.json<Envelope>();
      expect(body.error.code).toBe('internal_error');
      expect(res.body).not.toContain('SECRET-INTERNAL-DETAIL');
    } finally {
      await app.close();
    }
  });

  it('maps malformed JSON bodies to 400 invalid_json', async () => {
    const app = buildApp(makeConfig(tempDir()));
    app.post('/echo', async (request) => request.body);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{oops',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<Envelope>().error.code).toBe('invalid_json');
    } finally {
      await app.close();
    }
  });

  it('maps oversized bodies to 413 payload_too_large (body limit from config)', async () => {
    const dir = tempDir();
    const app = buildApp(makeConfig(dir, { LOBBY_BODY_LIMIT: '64' }));
    app.post('/echo', async (request) => request.body);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ text: 'x'.repeat(200) }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json<Envelope>().error.code).toBe('payload_too_large');
    } finally {
      await app.close();
    }
  });

  it('maps unknown routes to the 404 envelope', async () => {
    const app = buildApp(makeConfig(tempDir()));
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json<Envelope>().error.code).toBe('not_found');
    } finally {
      await app.close();
    }
  });
});
