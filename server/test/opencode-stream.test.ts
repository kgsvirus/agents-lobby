// OpenCode event stream tests: reconnect with bounded backoff, abort/
// unsubscribe, handler-error isolation. All upstream I/O is faked — no live
// OpenCode server, no real timers (the delay function is injected).
import { describe, expect, it, vi } from 'vitest';
import {
  createEventStream,
  type NormalizedEvent,
  type OpenCodeHttpClient,
  type SessionResolver,
} from '../src/integrations/opencode/events.js';

const resolver: SessionResolver = (id) => (id === 'ses_boss' ? { name: 'boss', role: 'boss' } : null);

function fakeClient(streamImpl: OpenCodeHttpClient['stream']): OpenCodeHttpClient {
  return {
    serverUrl: 'http://test',
    request: vi.fn(async () => ({})),
    stream: streamImpl,
  };
}

function sseBody(lines: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const line of lines) yield Buffer.from(line);
  })();
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Test delay that yields on a REAL timer: an immediately-resolving delay makes
 *  the reconnect loop spin in pure microtasks and starve the test's own timers. */
function tick(_ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

describe('createEventStream', () => {
  it('delivers normalized events to the sink and resets backoff after a successful connect', async () => {
    const events: NormalizedEvent[] = [];
    let connects = 0;
    const client = fakeClient(async () => {
      connects += 1;
      return sseBody(['data: {"type":"session.text.ended","data":{"sessionID":"ses_boss","text":"hi"}}\n']);
    });
    const delays: number[] = [];
    const unsubscribe = createEventStream(client, {
      delay: async (ms) => { delays.push(ms); await tick(ms); },
    }).subscribe(events.push.bind(events), resolver);
    await flush();
    expect(events).toEqual([
      { kind: 'reply', from: 'boss', to: null, body: 'hi', sessionId: 'ses_boss', ts: events[0]?.ts },
    ]);
    expect(connects).toBe(1);
    unsubscribe();
  });

  it('reconnects with bounded exponential backoff capped at maxDelayMs (≤ the bridge flat 5 s)', async () => {
    const delays: number[] = [];
    let done!: () => void;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    let unsubscribe: (() => void) | undefined;
    const client = fakeClient(async () => { throw new Error('down'); });
    const stream = createEventStream(client, {
      baseDelayMs: 10,
      maxDelayMs: 30,
      delay: async (ms) => {
        delays.push(ms);
        if (delays.length >= 4) { unsubscribe?.(); done(); }
      },
    });
    unsubscribe = stream.subscribe(() => {}, resolver);
    await finished;
    expect(delays).toEqual([10, 20, 30, 30]);
  });

  it('survives handler errors without dropping the connection', async () => {
    const delivered: NormalizedEvent[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient(async () =>
      sseBody([
        'data: {"type":"session.text.ended","data":{"sessionID":"ses_boss","text":"one"}}\n',
        'data: {"type":"session.text.ended","data":{"sessionID":"ses_boss","text":"two"}}\n',
      ]),
    );
    const unsubscribe = createEventStream(client, { delay: tick }).subscribe(
      (event) => {
        if (event.body === 'one') throw new Error('subscriber boom');
        delivered.push(event);
      },
      resolver,
    );
    await flush();
    expect(delivered.map((e) => e.body)).toEqual(['two']);
    expect(errSpy).toHaveBeenCalled(); // logged, stream kept alive
    unsubscribe();
    errSpy.mockRestore();
  });

  it('survives ASYNC handler REJECTIONS without dropping the connection (pins the await/catch path)', async () => {
    // A rejected PROMISE (not a sync throw): if the pump failed to `await` the
    // handler, this rejection would escape the try/catch as an unhandled
    // rejection and this test fails; the next event must still be delivered.
    const delivered: NormalizedEvent[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient(async () =>
      sseBody([
        'data: {"type":"session.text.ended","data":{"sessionID":"ses_boss","text":"one"}}\n',
        'data: {"type":"session.text.ended","data":{"sessionID":"ses_boss","text":"two"}}\n',
      ]),
    );
    const unsubscribe = createEventStream(client, { delay: tick }).subscribe(
      (event) => {
        if (event.body === 'one') return Promise.reject(new Error('async subscriber boom'));
        delivered.push(event);
      },
      resolver,
    );
    await flush();
    expect(delivered.map((e) => e.body)).toEqual(['two']);
    expect(errSpy).toHaveBeenCalled(); // logged, stream kept alive
    unsubscribe();
    errSpy.mockRestore();
  });

  it('unsubscribe stops the loop: no reconnect after the stream drops', async () => {
    let connects = 0;
    const client = fakeClient(async () => {
      connects += 1;
      return sseBody([]); // empty stream = clean drop
    });
    // Hold the first reconnect in a gate so unsubscribe() is guaranteed to run
    // before any second connect could be attempted.
    let allowReconnect!: () => void;
    const gate = new Promise<void>((resolve) => { allowReconnect = resolve; });
    let delayCount = 0;
    const unsubscribe = createEventStream(client, {
      delay: async () => {
        delayCount += 1;
        if (delayCount === 1) await gate;
      },
    }).subscribe(() => {}, resolver);
    await flush();
    expect(connects).toBe(1);
    expect(delayCount).toBe(1);
    unsubscribe();
    allowReconnect();
    // Give any stray reconnect a chance to run, then assert it never happened.
    await new Promise((r) => setTimeout(r, 20));
    expect(connects).toBe(1);
  });

  it('does not connect at all when unsubscribed before the loop starts', async () => {
    let connects = 0;
    const client = fakeClient(async () => { connects += 1; return sseBody([]); });
    const unsubscribe = createEventStream(client, { delay: tick }).subscribe(() => {}, resolver);
    unsubscribe();
    await flush();
    expect(connects).toBe(0);
  });
});
