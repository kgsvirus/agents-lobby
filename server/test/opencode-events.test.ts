// OpenCode event normalization tests. Fixtures are crafted from the bridge's
// ACTUAL parsing code paths (bridge.mjs:146-205):
//   - envelope: one `data:` line JSON = { type, data }
//   - session.inbox.enqueued → data.{sessionID, item.{type, payload.text}}
//   - session.text.ended     → data.{sessionID, text}
// All OpenCode interpretation must happen inside the adapter: the emitted
// events are protocol-neutral NormalizedEvents and malformed payloads are
// rejected (→ null) without crashing.
import { describe, expect, it } from 'vitest';
import { normalizeServerEvent, pumpSseStream, type SessionResolver } from '../src/integrations/opencode/events.js';

const TS = '2026-11-17T10:00:00.000Z';
const resolver: SessionResolver = (sessionId) => {
  if (sessionId === 'ses_boss') return { name: 'boss', role: 'boss' };
  if (sessionId === 'ses_dev') return { name: 'devx', role: 'agent' };
  return null;
};

describe('normalizeServerEvent', () => {
  it('normalizes a boss-session human inbox item (bridge.mjs:166-185 shape)', () => {
    const raw = {
      type: 'session.inbox.enqueued',
      data: { sessionID: 'ses_boss', item: { type: 'user', payload: { text: 'hello boss' } } },
    };
    expect(normalizeServerEvent(raw, resolver, TS)).toEqual({
      kind: 'inbox',
      from: 'human',
      to: 'boss',
      body: 'hello boss',
      sessionId: 'ses_boss',
      ts: TS,
    });
  });

  it('normalizes an agent-session user inbox item; the boss-only capture filter is chat policy, not the adapter', () => {
    const raw = {
      type: 'session.inbox.enqueued',
      data: { sessionID: 'ses_dev', item: { type: 'user', payload: { text: 'hi dev' } } },
    };
    expect(normalizeServerEvent(raw, resolver, TS)).toEqual({
      kind: 'inbox',
      from: 'human',
      to: 'devx',
      body: 'hi dev',
      sessionId: 'ses_dev',
      ts: TS,
    });
  });

  it('passes wake-prompt echoes through for the application to suppress (assessment §6 boundary split)', () => {
    const raw = {
      type: 'session.inbox.enqueued',
      data: {
        sessionID: 'ses_boss',
        item: { type: 'user', payload: { text: '[message received]\n\n[2026-11-17] [from: human] [to: boss] hi' } },
      },
    };
    // The adapter does NOT decide what to store: the echo is emitted with the
    // raw body; Phase 4 chat compares it against prompts IT enqueued.
    expect(normalizeServerEvent(raw, resolver, TS)).toMatchObject({ kind: 'inbox', body: raw.data.item.payload.text });
  });

  it('rejects non-user inbox item types and shape-less items (bridge.mjs:172-177 skips them)', () => {
    const base = { sessionID: 'ses_boss' };
    expect(normalizeServerEvent({ type: 'session.inbox.enqueued', data: { ...base, item: { type: 'message' } } }, resolver)).toBeNull();
    expect(normalizeServerEvent({ type: 'session.inbox.enqueued', data: { ...base, item: { type: 'user', payload: {} } } }, resolver)).toBeNull();
    expect(normalizeServerEvent({ type: 'session.inbox.enqueued', data: base }, resolver)).toBeNull();
    expect(normalizeServerEvent(
      { type: 'session.inbox.enqueued', data: { ...base, item: { type: 'user', payload: { text: '' } } } },
      resolver,
    )).toBeNull();
  });

  it('normalizes boss and agent session replies (bridge.mjs:186-204); to=null means chat routes it', () => {
    expect(
      normalizeServerEvent({ type: 'session.text.ended', data: { sessionID: 'ses_boss', text: 'boss reply' } }, resolver, TS),
    ).toEqual({ kind: 'reply', from: 'boss', to: null, body: 'boss reply', sessionId: 'ses_boss', ts: TS });
    expect(
      normalizeServerEvent({ type: 'session.text.ended', data: { sessionID: 'ses_dev', text: 'agent reply' } }, resolver, TS),
    ).toEqual({ kind: 'reply', from: 'devx', to: null, body: 'agent reply', sessionId: 'ses_dev', ts: TS });
  });

  it('rejects replies without text (bridge.mjs:186 `&& d.text`)', () => {
    expect(normalizeServerEvent({ type: 'session.text.ended', data: { sessionID: 'ses_boss' } }, resolver)).toBeNull();
    expect(normalizeServerEvent({ type: 'session.text.ended', data: { sessionID: 'ses_boss', text: '' } }, resolver)).toBeNull();
  });

  it('skips unresolvable sessions and unknown event types (bridge.mjs:165 skip semantics)', () => {
    expect(normalizeServerEvent({ type: 'session.text.ended', data: { sessionID: 'ses_unknown', text: 'x' } }, resolver)).toBeNull();
    expect(normalizeServerEvent({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_unknown', item: { type: 'user', payload: { text: 'x' } } } }, resolver)).toBeNull();
    expect(normalizeServerEvent({ type: 'session.error', data: { sessionID: 'ses_boss' } }, resolver)).toBeNull();
  });

  it('rejects malformed payloads without throwing (trust boundary)', () => {
    expect(normalizeServerEvent(null, resolver)).toBeNull();
    expect(normalizeServerEvent('data', resolver)).toBeNull();
    expect(normalizeServerEvent({}, resolver)).toBeNull();
    expect(normalizeServerEvent({ type: 42 }, resolver)).toBeNull();
    expect(normalizeServerEvent({ type: 'session.text.ended', data: { sessionID: 7, text: 'x' } }, resolver)).toBeNull();
    expect(normalizeServerEvent({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_boss', item: 'nope' } }, resolver)).toBeNull();
    expect(normalizeServerEvent({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_boss', item: { type: 'user', payload: { text: 1 } } } }, resolver)).toBeNull();
  });

  it('keeps extra envelope/data fields (loose objects — the bridge never restricts the shape)', () => {
    const raw = {
      type: 'session.text.ended',
      data: { sessionID: 'ses_boss', text: 'ok', extraField: { nested: true } },
      properties: 'ignored',
    };
    expect(normalizeServerEvent(raw, resolver, TS)).toMatchObject({ kind: 'reply', body: 'ok' });
  });
});

describe('pumpSseStream (bridge.mjs:146-159 port)', () => {
  async function collect(chunks: Array<Uint8Array | string>, onError?: (err: unknown, raw: string) => void) {
    const raws: unknown[] = [];
    await pumpSseStream(
      (async function* () { for (const c of chunks) yield c; })(),
      (raw) => { raws.push(raw); },
      onError,
    );
    return raws;
  }

  it('parses data: lines across chunk boundaries and skips non-data lines and bad JSON', async () => {
    const raws = await collect([
      Buffer.from('event: session.text.ended\n'), // non-data line skipped
      Buffer.from('data: {"type":"a"}\ndata: {"type"'), // split mid-JSON
      Buffer.from(':"b"}\n'),
      Buffer.from('data: not-json\n'), // malformed line → skipped, no crash
      Buffer.from('data: {"type":"c"}\n'),
    ]);
    expect(raws).toEqual([{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
  });

  it('tolerates a space after the colon and drops an unterminated trailing line (bridge.mjs:146-151 — the buffer remainder is never flushed, matching the bridge)', async () => {
    const raws = await collect(['data: {"type":"y"}\n', 'data: {"type":"z"}']); // no trailing newline → dropped
    expect(raws).toEqual([{ type: 'y' }]);
  });

  it('decodes multi-byte characters split across chunks (streaming TextDecoder)', async () => {
    const emoji = Buffer.from('🙂', 'utf8'); // 4 bytes, split 2+2 across chunks
    const out = await collect([
      Buffer.concat([Buffer.from('data: {"text":"', 'utf8'), emoji.slice(0, 2)]),
      Buffer.concat([emoji.slice(2), Buffer.from('"}\n')]),
    ]);
    expect(out).toEqual([{ text: '🙂' }]);
  });

  it('does not kill the stream when a handler throws synchronously', async () => {
    const raws: unknown[] = [];
    let calls = 0;
    await pumpSseStream(
      (async function* () {
        yield 'data: {"type":"bad"}\n';
        yield 'data: {"type":"good"}\n';
      })(),
      (raw) => {
        calls += 1;
        if ((raw as { type: string }).type === 'bad') throw new Error('handler boom');
        raws.push(raw);
      },
    );
    expect(calls).toBe(2);
    expect(raws).toEqual([{ type: 'good' }]);
  });
});
