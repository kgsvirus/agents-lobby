// useMessages — SSE/REST catch-up flow (mirrors the legacy hook):
//   initial load = REST after=0 page; every stream open triggers an
//   after=<newestId> REST catch-up; message.created frames append live
//   (deduped, id-ordered). The I1 invariant test pins the reconnect-resume
//   rule: a failed catch-up pass leaves a resume cursor and the NEXT open
//   resumes from that cursor — never from the SSE-advanced max, which can
//   sit past unfetched backlog.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMessages, viewKey } from '../src/hooks/useMessages';
import { Agent, View } from '../src/lib/api';
import { FakeEventSource } from './fake-event-source';

const AGENTS: Agent[] = [{ name: 'taskflow', project: 'TaskFlow' }];
const BOSS: View = { kind: 'boss' };

interface Row { id: number; from: string; to: string | null; text: string; time: string }
const row = (id: number, from = 'boss', to: string | null = null): Row => ({
  id, from, to, text: `m${id}`, time: '2026-11-17T10:00:00.000Z',
});
const wire = (r: Row): string => JSON.stringify(r);

const page = (rows: Row[], hasMore = false) => ({ messages: rows, hasMore });

let calls: URLSearchParams[] = [];
let handler: (p: URLSearchParams) => { fail?: boolean; body: unknown };

beforeEach(() => {
  calls = [];
  handler = () => ({ body: page([]) });
  vi.stubGlobal('EventSource', vi.fn(() => new FakeEventSource('/api/events')));
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const params = new URL(String(input), 'http://x').searchParams;
    calls.push(params);
    const r = handler(params);
    if (r.fail) return { ok: false, status: 500, text: async () => JSON.stringify({ error: { code: 'internal_error', message: 'boom' } }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(r.body) };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const lastEventSource = (): FakeEventSource =>
  FakeEventSource.instances[FakeEventSource.instances.length - 1];

/** Standard routing: recents fill, boss initial page, boss catch-up pages.
 *  Note the legacy client omits `after=0` (falsy) — the initial page carries
 *  NO after param at all. */
const routeBoss = (initial: Row[], catchUp: Row[] = []) => {
  handler = (p) => {
    const view = p.get('view');
    if (view === 'all') return { body: page(initial) }; // recents fill (limit=50, no after)
    if (p.get('after') === null && p.get('limit') === '10') return { body: page(initial, false) };
    return { body: page(catchUp) }; // catch-up fetch (after=<newestId> limit=50)
  };
};

describe('viewKey', () => {
  it('keys caches per sidebar selection', () => {
    expect(viewKey(null)).toBe('all');
    expect(viewKey({ kind: 'boss' })).toBe('boss');
    expect(viewKey({ kind: 'agent', name: 'taskflow' })).toBe('agent:taskflow');
  });
});

describe('initial load + stream-open catch-up', () => {
  it('loads the initial page and catches up with after=<newestId> on open', async () => {
    routeBoss([row(1), row(2)], [row(3)]);
    const { result } = renderHook(() => useMessages(BOSS, AGENTS));

    await waitFor(() => expect(result.current.feed.ready).toBe(true));
    expect(result.current.feed.messages.map((m) => m.id)).toEqual([1, 2]);

    lastEventSource().open(); // stream open → catch-up

    await waitFor(() => expect(result.current.feed.messages.map((m) => m.id)).toEqual([1, 2, 3]));
    const catchUpCall = calls[calls.length - 1];
    expect(catchUpCall.get('after')).toBe('2');
    expect(catchUpCall.get('limit')).toBe('50');
    expect(catchUpCall.get('view')).toBe('boss');
  });

  it('appends message.created frames into the active view (deduped) and recents', async () => {
    routeBoss([row(1)]);
    const { result } = renderHook(() => useMessages(BOSS, AGENTS));
    await waitFor(() => expect(result.current.feed.ready).toBe(true));

    const es = lastEventSource();
    es.emit('message.created', wire(row(2, 'taskflow', 'boss')));
    es.emit('message.created', wire(row(1))); // duplicate id — must not double-render

    await waitFor(() => expect(result.current.feed.messages.map((m) => m.id)).toEqual([1, 2]));
    expect(result.current.recents.some((m) => m.id === 2)).toBe(true);
  });

  it('closes the stream on unmount', async () => {
    routeBoss([]);
    const { unmount } = renderHook(() => useMessages(BOSS, AGENTS));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const es = lastEventSource();
    unmount();
    expect(es.closed).toBe(true);
  });
});

describe('I1 — reconnect resume never skips unfetched backlog', () => {
  it('a failed catch-up leaves a resume cursor; the next open resumes from it', async () => {
    routeBoss([row(1), row(2)]);
    const { result } = renderHook(() => useMessages(BOSS, AGENTS));
    await waitFor(() => expect(result.current.feed.ready).toBe(true));

    // First open: catch-up fetch fails → resume cursor stays at the START id.
    handler = (p) => (p.get('after') !== null ? { fail: true, body: null } : { body: page([row(1), row(2)]) });
    lastEventSource().open();
    await waitFor(() => {
      const c = calls[calls.length - 1];
      return c.get('after') === '2' && c.get('limit') === '50';
    });
    // no catch-up rerender with rows; ready stays true, messages unchanged
    expect(result.current.feed.messages.map((m) => m.id)).toEqual([1, 2]);

    // SSE advances the cache to 3 while the backlog (rows 3..) is unfetched.
    act(() => lastEventSource().emit('message.created', wire(row(9, 'taskflow', 'boss'))));
    expect(result.current.feed.messages.map((m) => m.id)).toEqual([1, 2, 9]);

    // Reconnect: catch-up MUST resume from after=2 (the cursor), not from the
    // SSE-advanced max (9) — 3..8 would be lost.
    handler = (p) => {
      if (p.get('after') === '2') return { body: page([row(3), row(4)], true) }; // full page: more remain
      if (p.get('after') === '4') return { body: page([row(5)]) }; // drain completes
      return { body: page([]) };
    };
    lastEventSource().open();

    await waitFor(() => expect(result.current.feed.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 9]));
    const resumes = calls
      .filter((c) => c.get('limit') === '50' && c.get('view') === 'boss')
      .map((c) => c.get('after'));
    expect(resumes).toEqual(['2', '2', '4']); // failed pass, retry from cursor, drain continues
  });
});

describe('loadOlder', () => {
  it('prepends the next older page and updates hasMore', async () => {
    handler = (p) => {
      if (p.get('before')) return { body: page([row(1), row(2)]) };
      if (p.get('view') === 'all') return { body: page([row(3), row(4)], true) };
      return { body: page([row(3), row(4)], true) }; // initial page claims more older rows
    };
    const { result } = renderHook(() => useMessages(BOSS, AGENTS));
    await waitFor(() => expect(result.current.feed.hasMore).toBe(true));

    act(() => result.current.loadOlder());

    await waitFor(() => expect(result.current.feed.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]));
    expect(result.current.feed.hasMore).toBe(false);
  });

  it('an SSE row below oldestId does NOT duplicate on the next older-page load', async () => {
    // Fresh SSE connections start at the live head (no history replay), but a
    // late catch-up row below oldestId can still land in the cache appended
    // at its sorted position — the older-page load must not prepend it twice.
    handler = (p) => {
      if (p.get('before')) return { body: page([row(1), row(2)]) };
      if (p.get('view') === 'all') return { body: page([row(3), row(4)]) };
      return { body: page([row(3), row(4)], true) }; // initial: more older rows exist
    };
    const { result } = renderHook(() => useMessages(BOSS, AGENTS));
    await waitFor(() => expect(result.current.feed.ready).toBe(true));
    expect(result.current.feed.hasMore).toBe(true);

    const es = lastEventSource();
    es.open(); // catch-up: after=<newestId>, returns nothing new
    await waitFor(() => expect(calls.some((c) => c.get('after') === '4')).toBe(true));

    act(() => es.emit('message.created', wire(row(1, 'taskflow', 'boss'))));
    await waitFor(() => expect(result.current.feed.messages.map((m) => m.id)).toEqual([1, 3, 4]));

    handler = (p) => (p.get('before') ? { body: page([row(1), row(2)]) } : { body: page([row(3), row(4)], true) });
    act(() => result.current.loadOlder());

    await waitFor(() => expect(result.current.feed.hasMore).toBe(false));
    expect(result.current.feed.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]); // id 1 exactly once
  });

  it('a stream open does NOT backfill history — only after=<newestId> catch-up', async () => {
    handler = (p) => {
      if (p.get('view') === 'all') return { body: page([row(3), row(4)]) };
      if (p.get('after') === null && p.get('limit') === '10') return { body: page([row(3), row(4)], true) };
      return { body: page([]) }; // catch-up: nothing newer
    };
    const { result } = renderHook(() => useMessages(BOSS, AGENTS));
    await waitFor(() => expect(result.current.feed.ready).toBe(true));
    expect(result.current.feed.hasMore).toBe(true); // older rows 1-2 exist, unfetched

    const es = lastEventSource();
    es.open(); // no cursor replayed by the server; the hook REST-catches up
    await waitFor(() => expect(calls.some((c) => c.get('after') === '4' && c.get('view') === 'boss')).toBe(true));

    expect(result.current.feed.messages.map((m) => m.id)).toEqual([3, 4]); // no history injected
    expect(result.current.feed.hasMore).toBe(true); // older page still pending for scroll
  });
});
