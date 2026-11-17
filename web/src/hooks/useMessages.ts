'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Agent,
  Message,
  MessagePage,
  View,
  fetchMessages,
  isVisible,
  subscribeStream,
} from '../lib/api';

export interface ViewFeed {
  messages: Message[];
  hasMore: boolean; // older messages remain above
  loadingOlder: boolean;
  ready: boolean; // initial page fetched
}

// Stable key per sidebar selection — each keeps its own loaded history.
export const viewKey = (view: View | null): string =>
  !view
    ? 'all'
    : view.kind === 'all'
      ? 'all'
      : view.kind === 'boss'
        ? 'boss'
        : `${view.kind}:${(view as { name: string }).name}`;

const PAGE = 10;

interface Cache {
  messages: Message[];
  oldestId: number;
  newestId: number;
  // I1 invariant: the catch-up cursor never jumps over unfetched rows. SSE
  // appends may advance newestId past a backlog, but while a drain pass is
  // incomplete, resumeCursor holds the last id the pass actually FETCHED (its
  // START cursor if nothing was fetched) and every pass resumes from it — a
  // pass may clear resumeCursor ONLY when it observes hasMore=false.
  resumeCursor: number | null;
  // M2: bumped when a drain pass starts and again when it finishes writing
  // the cursor. In-flight fetches capture the value they dispatched under and
  // may write the cursor only while it is unchanged — a stale/superseded
  // response (a late view-switch page vs a finished drain) cannot move
  // resumeCursor backwards over already-drained ranges.
  drainEpoch: number;
  hasMore: boolean;
  loadingOlder: boolean;
  ready: boolean;
}

// Ported verbatim from the legacy src/hooks/useMessages.ts (the I1/M2 drain
// semantics are the correctness core of the feed); only the SSE subscription
// moved to the new /api/events contract (subscribeStream in lib/api.ts).
export function useMessages(view: View, agents: Agent[]) {
  // Per-view caches live in a ref (mutable, no re-render churn); the bump
  // counter only triggers re-renders when the ACTIVE view's data changes.
  const caches = useRef(new Map<string, { view: View; cache: Cache }>());
  const recents = useRef<Message[]>([]); // latest messages overall (sidebar stamps)
  const [, bump] = useState(0);
  const rerender = () => bump((n) => n + 1);
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  const agentsRef = useRef<Agent[]>(agents);
  agentsRef.current = agents;

  // Merge an initial/scratch page into a cache by id (F2): rows that arrived
  // via SSE during the request survive; dedupe by id, keep id order.
  const mergeInitial = (c: Cache, page: MessagePage) => {
    const seen = new Set(c.messages.map((m) => m.id));
    c.messages = [...c.messages, ...page.messages.filter((m) => !seen.has(m.id))].sort(
      (a, b) => a.id - b.id,
    );
    c.oldestId = c.messages[0]?.id ?? 0;
    c.newestId = c.messages[c.messages.length - 1]?.id ?? 0;
    c.hasMore = page.hasMore;
    c.resumeCursor = null; // initial-direction pages re-baseline; the drain's empty-feed fill branch overrides this when its page claims more (I1)
    c.ready = true;
  };

  // Recents for the sidebar: latest 50 overall + SSE appends (merged by id —
  // F2 — so rows landing during the fetch survive). Stamps primarily come
  // from /api/last-activity; this window is the fallback.
  useEffect(() => {
    fetchMessages({ kind: 'all' }, { after: 0, limit: 50 })
      .then((page) => {
        const seen = new Set(recents.current.map((m) => m.id));
        recents.current = [
          ...recents.current,
          ...page.messages.filter((m) => !seen.has(m.id)),
        ].sort((a, b) => a.id - b.id);
        if (recents.current.length > 50) recents.current = recents.current.slice(-50);
        rerender();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Init the active view on switch (its cache persists across switches —
  // switching away and back reuses the loaded history; only a first visit
  // fetches). Existing caches catch up silently on switch: SSE appends
  // keep them live, but a stream downtime may leave a gap — after=<newestId>
  // closes it without a loading flash. A cache stuck not-ready (its initial
  // fetch failed — F4) retries the initial fetch here instead of returning
  // forever; the stream-open catch-up retries it too.
  useEffect(() => {
    const key = viewKey(viewRef.current);
    let entry = caches.current.get(key);
    if (entry && entry.cache.ready) {
      const c = entry.cache;
      if (!c.newestId) return;
      // M2: claim the current drain generation. If a catch-up pass starts or
      // finishes while this fetch is in flight, this stale response must not
      // write resumeCursor back over already-drained ranges.
      const myEpoch = c.drainEpoch;
      fetchMessages(viewRef.current, { after: c.resumeCursor ?? c.newestId, limit: 50 })
        .then((page) => {
          const seen = new Set(c.messages.map((m) => m.id));
          const fresh = page.messages.filter((m) => !seen.has(m.id));
          if (fresh.length) {
            // New array identity (F5) so ChatFeed's layout effect re-fires;
            // sorted merge (ordering): a stale page can carry rows older than
            // SSE rows already appended — the feed never shows newer before
            // older.
            c.messages = [...c.messages, ...fresh].sort((a, b) => a.id - b.id);
            c.newestId = Math.max(c.newestId, ...fresh.map((m) => m.id));
          }
          // Same cursor rule as catch-up (I1/M2): a full page (more newer rows
          // exist) leaves the drain pending at this page's last id; a short
          // page means the range is fully covered — re-baseline to the max.
          // Applied only if no drain started/ended since dispatch (M2) —
          // a superseded write is dropped, the newer pass owns the cursor.
          if (c.drainEpoch === myEpoch) {
            c.resumeCursor =
              page.hasMore && page.messages.length
                ? page.messages[page.messages.length - 1].id
                : null;
          }
          rerender();
        })
        .catch(() => {});
      return;
    }
    if (!entry) {
      entry = {
        view: viewRef.current,
        cache: { messages: [], oldestId: 0, newestId: 0, resumeCursor: null, drainEpoch: 0, hasMore: false, loadingOlder: false, ready: false },
      };
      caches.current.set(key, entry);
      rerender();
    }
    fetchMessages(viewRef.current, { after: 0, limit: PAGE })
      .then((page) => {
        if (caches.current.get(key) !== entry) return;
        mergeInitial(entry.cache, page);
        rerender();
      })
      .catch(() => {
        /* server down — entry stays not-ready; retried on next switch/stream open */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // SSE: one connection; each row is appended into every cached view it
  // belongs to (visibility per D11), so inactive views stay current too.
  useEffect(() => {
    const append = (row: Message) => {
      for (const [key, entry] of caches.current) {
        if (!isVisible(row, entry.view, agentsRef.current)) continue;
        const c = entry.cache;
        if (c.messages.some((m) => m.id === row.id)) continue;
        // New array identity (F5): ChatFeed's layout effect only re-fires on
        // a msgs reference change — in-place pushes left the effect dead and
        // appended rows permanently off-screen.
        // Ordering: the cache stays id-ascending — a drained catch-up row can
        // be older than SSE rows already appended (e.g. 401 landed while the
        // cursor sat at 350), so insert at its sorted position, not the end.
        let i = c.messages.length;
        while (i > 0 && c.messages[i - 1].id > row.id) i--;
        c.messages = [...c.messages.slice(0, i), row, ...c.messages.slice(i)];
        c.newestId = Math.max(c.newestId, row.id);
        if (key === viewKey(viewRef.current)) rerender();
      }
      // recents = "latest 50 by id" (M1): dedupe by id AND never let a
      // below-window row in — an old row arriving late (catch-up overlap)
      // must not evict a newer one. Kept sorted by id ascending.
      if (!recents.current.some((m) => m.id === row.id)) {
        const len = recents.current.length;
        const lastId = recents.current[len - 1]?.id ?? 0;
        if (len < 50 || row.id > lastId) {
          let i = len;
          while (i > 0 && recents.current[i - 1].id > row.id) i--;
          recents.current.splice(i, 0, row);
          if (recents.current.length > 50) recents.current.shift();
        }
      }
      rerender();
    };
    const es = subscribeStream((row) => append(row));
    // Catch up on EVERY stream open (F3): the initial fetch may have missed
    // rows that landed before the stream connected, and a reconnect after a
    // drop needs after=<newestId> (the SSE side ALSO replays missed events
    // from the persisted sequence via Last-Event-ID; the REST catch-up closes
    // the same gap from the messages table). Inactive views catch up when
    // switched to. Terminates: each page fetches strictly newer rows.
    const catchUp = async () => {
      const key = viewKey(viewRef.current);
      const entry = caches.current.get(key);
      if (!entry) return;
      const c = entry.cache;
      if (!c.ready) {
        // Initial fetch failed: retry it from scratch here (F4).
        const page = await fetchMessages(entry.view, { limit: PAGE }).catch(() => null);
        if (!page || caches.current.get(key) !== entry) return;
        mergeInitial(c, page);
        rerender();
        return;
      }
      // I1: start from the pending drain cursor if one exists — NEVER from
      // the SSE-advanced cache max, which may sit past unfetched backlog.
      let after = c.resumeCursor ?? c.newestId;
      // M2: this pass owns the cursor until a newer pass starts. All cursor
      // writes go through writeCursor; the trailing bump also invalidates
      // switch fetches that dispatched mid-pass.
      const myEpoch = ++c.drainEpoch;
      const writeCursor = (v: number | null) => {
        if (c.drainEpoch !== myEpoch) return; // superseded — the newer pass writes
        c.resumeCursor = v;
        c.drainEpoch++; // pass over — late switch writes from this generation are ignored
      };
      // High-water bound (M2): with inserts arriving faster than pages fetch,
      // this loop could run forever — cap a pass at 10 pages (500 rows); the
      // remainder stays pending in resumeCursor and is drained by the next
      // stream-open/switch pass.
      const MAX_PAGES = 10;
      let pages = 0;
      for (;;) {
        const page = await fetchMessages(entry.view, { after, limit: 50 }).catch(() => null);
        if (!page) {
          // Fetch failed: ALWAYS leave a resume cursor (I1) — the last
          // fetched id mid-drain (pages > 0), or the pass's START cursor on a
          // first-fetch failure (pages === 0, nothing fetched) — so the next
          // pass resumes there instead of from the SSE-advanced max.
          writeCursor(after);
          return;
        }
        if (after === 0) {
          // Empty feed: this page IS the initial fill (carries hasMore/oldest).
          // I1 purity: the fill is a drained page too — its cursor clears only
          // on an OBSERVED hasMore=false (mergeInitial's null stands); a
          // hasMore fill leaves the drain pending at its last fetched id and
          // the loop drains the remainder now. Note a pending cursor of 0
          // here (saved by a failed first fetch — see coexistence note) must
          // ADVANCE to the last fetched id, not survive: 0 would re-fill the
          // same page on every pass.
          mergeInitial(c, page);
          rerender();
          if (!page.messages.length) {
            if (page.hasMore) writeCursor(after); // claims more, returned nothing — keep a retry cursor
            return;
          }
          after = page.messages[page.messages.length - 1].id;
          if (!page.hasMore) return; // observed hasMore=false — mergeInitial's null IS the clear
          writeCursor(after); // hasMore fill: backlog continues at the last fetched id
          if (++pages >= MAX_PAGES) return;
          continue;
        }
        for (const row of page.messages) append(row);
        if (!page.hasMore) {
          writeCursor(null); // fully drained — cache max is the cursor again (I1: only clear here)
          rerender();
          return;
        }
        if (!page.messages.length) {
          // Server claims more but returned nothing: keep the cursor (I1 —
          // clear only on hasMore=false) and retry the range next pass; each
          // pass is one bounded fetch, so this terminates.
          writeCursor(after);
          return;
        }
        after = page.messages[page.messages.length - 1].id;
        if (++pages >= MAX_PAGES) {
          writeCursor(after); // cap reached — backlog continues here
          return;
        }
      }
    };
    es.onopen = () => {
      catchUp();
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll-to-top trigger: fetch the next older page, prepend, keep scroll
  // anchored (ChatFeed handles the position restore).
  const loadOlder = useCallback(() => {
    const key = viewKey(viewRef.current);
    const entry = caches.current.get(key);
    if (!entry || !entry.cache.ready || !entry.cache.hasMore || entry.cache.loadingOlder) return;
    entry.cache.loadingOlder = true;
    rerender();
    const oldest = entry.cache.oldestId;
    fetchMessages(viewRef.current, { before: oldest, limit: PAGE })
      .then((page) => {
        const c = caches.current.get(key)?.cache;
        if (!c) return;
        // Overlap guard: a late SSE/catch-up row below `oldest` can already
        // sit in the cache (appended at its sorted position without updating
        // oldestId) — dedupe by id and re-sort so the feed stays id-ascending
        // with no duplicate prepend.
        const known = new Set(c.messages.map((m) => m.id));
        const fresh = page.messages.filter((m) => !known.has(m.id));
        c.messages = [...fresh, ...c.messages].sort((a, b) => a.id - b.id);
        c.oldestId = fresh[0]?.id ?? c.oldestId;
        c.hasMore = page.hasMore;
        c.loadingOlder = false;
        rerender();
      })
      .catch(() => {
        const c = caches.current.get(key)?.cache;
        if (c) {
          c.loadingOlder = false;
          rerender();
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = caches.current.get(viewKey(view));
  return {
    feed: active
      ? { ...active.cache }
      : { messages: [] as Message[], hasMore: false, loadingOlder: false, ready: false },
    loadOlder,
    recents: recents.current,
  };
}
