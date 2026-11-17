// API client — error-envelope adaptation (standing Phase 6 ruling): every
// consumer reads the message from the shared envelope
// { error: { code, message } } via ApiError; the legacy client treated
// `error` as a plain string and would have rendered an object.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchAgents,
  promptBoss,
  readErrorEnvelope,
  requestJson,
  sendMessage,
} from '../src/lib/api';

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

describe('readErrorEnvelope', () => {
  it('reads code + message from the shared envelope', () => {
    expect(readErrorEnvelope({ error: { code: 'not_found', message: 'no targets' } })).toEqual({
      code: 'not_found',
      message: 'no targets',
    });
  });

  it('tolerates the legacy plain-string error shape', () => {
    expect(readErrorEnvelope({ error: 'Invalid JSON' })).toEqual({
      code: 'error',
      message: 'Invalid JSON',
    });
  });

  it('returns null for non-envelope bodies and missing message', () => {
    expect(readErrorEnvelope({ error: { code: 'x' } })).toBeNull();
    expect(readErrorEnvelope({})).toBeNull();
    expect(readErrorEnvelope(null)).toBeNull();
    expect(readErrorEnvelope('boom')).toBeNull();
  });
});

describe('requestJson error path', () => {
  it('throws ApiError carrying the envelope message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { error: { code: 'not_found', message: 'no targets' } })),
    );
    await expect(requestJson('/api/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'not_found',
      message: 'no targets',
    });
  });

  it('falls back to a generic message for non-envelope/non-JSON bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => '<html>' }) as unknown as Response),
    );
    const err = await requestJson('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Request failed (500)');
  });
});

describe('send/prompt consumers', () => {
  it('sendMessage surfaces the envelope message (e.g. legacy 404 no targets)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { error: { code: 'not_found', message: 'no available targets' } })),
    );
    await expect(sendMessage(['a'], 'hello', 'human')).rejects.toThrow('no available targets');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/send');
  });

  it('promptBoss surfaces the envelope message (e.g. legacy 400 empty message)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(400, { error: { code: 'bad_request', message: 'message is required' } })),
    );
    await expect(promptBoss('')).rejects.toMatchObject({ message: 'message is required' });
  });

  it('resolve on success payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { sent: ['a'], skipped: [] })),
    );
    await expect(sendMessage(['a'], 'hello')).resolves.toEqual({ sent: ['a'], skipped: [] });
  });
});

describe('fetchAgents', () => {
  it('returns the registry list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, [{ name: 'boss', project: 'Agents-Lobby' }])),
    );
    await expect(fetchAgents()).resolves.toEqual([{ name: 'boss', project: 'Agents-Lobby' }]);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/agents'); // exact path — no query (server 404s those)
  });
});
