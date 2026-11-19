// API client — error-envelope adaptation (standing Phase 6 ruling): every
// consumer reads the message from the shared envelope
// { error: { code, message } } via ApiError; the legacy client treated
// `error` as a plain string and would have rendered an object.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  connectBrowser,
  disconnectBrowser,
  fetchAgents,
  fetchAuthMode,
  getHumanToken,
  isDisconnected,
  promptBoss,
  readErrorEnvelope,
  requestJson,
  sendMessage,
  setHumanToken,
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
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/agents'); // exact path - no query (server 404s those)
  });
});

// --- Human token (peer messaging) -------------------------------------------
describe('human token', () => {
  const store = new Map<string, string>();

  const stubStorage = () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  };

  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('sends no Authorization header when no token is connected', async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => jsonResponse(200, { sent: ['a'], skipped: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await sendMessage(['a'], 'hello', 'human');
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('attaches the token to /send and /prompt when connected', async () => {
    stubStorage();
    setHumanToken('t');
    const fetchMock = vi.fn(async () => jsonResponse(200, { sent: ['a'], skipped: [], status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    await sendMessage(['a'], 'hello', 'human');
    await promptBoss('hi');
    for (const call of fetchMock.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    }
  });

  it('stores and clears the token', () => {
    stubStorage();
    setHumanToken('t');
    expect(getHumanToken()).toBe('t');
    setHumanToken(null);
    expect(getHumanToken()).toBeNull();
  });
});

// --- Browser auto-connect ----------------------------------------------------
describe('browser auto-connect', () => {
  const store = new Map<string, string>();
  const stubStorage = () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  };

  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('connects through POST /api/connect with a JSON content type and no Authorization header', async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => jsonResponse(200, { name: 'human', kind: 'human' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(connectBrowser()).resolves.toEqual({ name: 'human', kind: 'human' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/connect');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('disconnect is sticky for the tab', async () => {
    stubStorage();
    const fetchMock = vi.fn(async () => jsonResponse(200, { status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(isDisconnected()).toBe(false);
    await disconnectBrowser();
    expect(isDisconnected()).toBe(true);
    await connectBrowser();
    expect(isDisconnected()).toBe(false);
  });

  it('reads the auth mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { mode: 'identity' })));
    await expect(fetchAuthMode()).resolves.toBe('identity');
  });
});

describe('401 reconnect-retry', () => {
  const store = new Map<string, string>();
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it('connects once and retries when a cookie write is rejected (server restart)', async () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/send' && calls.filter((c) => c === '/send').length === 1) {
        return jsonResponse(401, { error: { code: 'unauthorized', message: 'no session' } });
      }
      if (url === '/api/connect') return jsonResponse(200, { name: 'human', kind: 'human' });
      return jsonResponse(200, { sent: ['boss'], skipped: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendMessage(['boss'], 'hi', 'human')).resolves.toEqual({ sent: ['boss'], skipped: [] });
    expect(calls).toEqual(['/send', '/api/connect', '/send']);
  });

  it('does not retry when the tab opted out', async () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => (k === 'lobby.disconnected' ? '1' : (store.get(k) ?? null)),
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse(401, { error: { code: 'unauthorized', message: 'no session' } });
    }));
    await expect(sendMessage(['boss'], 'hi', 'human')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual(['/send']);
  });
});
