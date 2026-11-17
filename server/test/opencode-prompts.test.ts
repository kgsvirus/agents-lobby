// OpenCode prompt port tests (bridge.mjs:86-92 port, retired on main in
// 809440a) + the byte-identical wake-prompt contract (bridge.mjs:94, 114-118),
// now pinned against the adapter's own constant. Upstream is a fake — no live
// server, and never a real prompt to a real session.
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeRequestError, type OpenCodeHttpClient } from '../src/integrations/opencode/client.js';
import { createOpenCodeClient } from '../src/integrations/opencode/client.js';
import {
  composeWakePrompt,
  createPromptPort,
  formatWakeLine,
  parseWakeLine,
  WAKE_PROMPT,
} from '../src/integrations/opencode/prompts.js';

function capturingClient(): { client: OpenCodeHttpClient; calls: Array<{ pathname: string; init: RequestInit }> } {
  const calls: Array<{ pathname: string; init: RequestInit }> = [];
  return {
    calls,
    client: {
      serverUrl: 'http://test',
      request: vi.fn(async (pathname: string, init?: RequestInit) => {
        calls.push({ pathname, init: init ?? {} });
        return {};
      }),
      stream: vi.fn(async () => { throw new Error('not used'); }),
    },
  };
}

describe('prompt port (bridge.mjs:86-92 port)', () => {
  it('POSTs the queued prompt with the exact bridge request shape', async () => {
    const { client, calls } = capturingClient();
    await createPromptPort(client).prompt('ses_dev', 'Boss: hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('/api/session/ses_dev/prompt');
    expect(calls[0]?.init.method).toBe('POST');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
    // delivery: "queue" is adapter-internal — no option crosses the port.
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: 'Boss: hello', delivery: 'queue' });
  });

  it('isAvailable mirrors the bridge !SERVER_URL semantics (discovery injected — no spawn)', () => {
    // A fallback URL resolves → available; neither discovery nor fallback → not.
    const withUrl = createOpenCodeClient({ fallbackServerUrl: 'http://fallback:1' }, { discover: () => null });
    expect(createPromptPort(withUrl).isAvailable()).toBe(true);
    const withoutUrl = createOpenCodeClient({ fallbackServerUrl: null }, { discover: () => null });
    expect(createPromptPort(withoutUrl).isAvailable()).toBe(false);
  });

  it('rejects with the NEUTRAL PortError on upstream failure (fan-out "skipped" signal)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: OpenCodeHttpClient = {
      serverUrl: 'http://test',
      request: vi.fn(async () => { throw new OpenCodeRequestError('/p', 500, 'secret-body'); }),
      stream: vi.fn(async () => { throw new Error('not used'); }),
    };
    await expect(createPromptPort(failing).prompt('ses_dev', 'x')).rejects.toMatchObject({
      name: 'PortError',
      code: 'upstream-error',
    });
    await expect(createPromptPort(failing).prompt('ses_dev', 'x')).rejects.toSatisfy((err: unknown) => {
      const e = err as Error;
      return !e.message.includes('/p') && !e.message.includes('secret-body') && !('cause' in e);
    });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('wake-prompt bytes (bridge.mjs:94, 114-118 — MUST stay byte-identical)', () => {
  it('the constant is the exact wake string', () => {
    expect(WAKE_PROMPT).toBe('[message received]');
  });

  it('empty slice → the bare wake prompt (bridge.mjs:118)', () => {
    expect(composeWakePrompt([])).toBe('[message received]');
  });

  it('non-empty slice → prompt + \\n\\n + marker lines joined by \\n (bridge.mjs:114-117)', () => {
    expect(
      composeWakePrompt([
        { time: '2026-11-17T10:00:00.000Z', from: 'human', to: 'boss', text: 'hello boss' },
        { time: '2026-11-17T10:00:01.000Z', from: 'devx', to: 'all', text: 'hi there' },
        { time: '2026-11-17T10:00:02.000Z', from: 'legacy', to: null, text: 'no receiver' },
      ]),
    ).toBe(
      '[message received]\n\n' +
      '[2026-11-17T10:00:00.000Z] [from: human] [to: boss] hello boss\n' +
      '[2026-11-17T10:00:01.000Z] [from: devx] [to: all] hi there\n' +
      '[2026-11-17T10:00:02.000Z] [from: legacy] [to: null] no receiver',
    );
  });

  it('marker lines parse back (compose/parse symmetry, assessment §6)', () => {
    const line = { time: '2026-11-17T10:00:00.000Z', from: 'human', to: 'boss', text: 'hello [world]' };
    const formatted = formatWakeLine(line);
    expect(formatted).toBe('[2026-11-17T10:00:00.000Z] [from: human] [to: boss] hello [world]');
    expect(parseWakeLine(formatted)).toEqual(line);
    expect(parseWakeLine('[2026-11-17] [from: a] [to: null] text')).toEqual({
      time: '2026-11-17', from: 'a', to: 'null', text: 'text',
    });
    expect(parseWakeLine('no markers here')).toBeNull();
    expect(parseWakeLine('[time] [from: a] text')).toBeNull(); // missing [to: …]
    expect(parseWakeLine('[time] [from: a] [to: b]')).toBeNull(); // missing text
    expect(parseWakeLine('')).toBeNull();
  });
});
