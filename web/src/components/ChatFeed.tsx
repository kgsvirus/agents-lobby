import { useLayoutEffect, useRef } from 'react';
import type { Message } from '../lib/api';
import { MessageBubble } from './MessageBubble';

export function ChatFeed({
  active = true,
  msgs,
  directional,
  loadingOlder,
  hasMore,
  ready,
  onLoadOlder,
  resetKey,
}: {
  active?: boolean;
  msgs: Message[];
  directional?: boolean;
  loadingOlder?: boolean;
  hasMore?: boolean;
  ready?: boolean;
  onLoadOlder?: () => void;
  resetKey: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // display:none zeroes scrollTop, so when the module round-trips the feed
  // re-display restores the reader's position from here (see the reShow
  // path in the layout effect).
  const lastScroll = useRef(0);
  // Set when a render happens with the feed hidden; the next visible
  // layout-effect run does the re-show position restore (R2b).
  const wasHidden = useRef(false);
  // Scroll anchoring: when an older page prepends, keep the user's reading
  // position instead of letting the container jump to the new top. atBottom
  // records where the reader rested after the previous render, so an APPEND
  // (firstId unchanged) can follow the bottom only if they were there.
  const anchor = useRef({
    key: '',
    firstId: 0,
    atBottom: true,
    // Element anchor: the message the reader was looking at when the
    // older-page load triggered, and where it sat in the viewport. Height
    // deltas are wrong here — live SSE appends grow the BOTTOM between
    // renders, so `scrollTop += newH − oldH` over-scrolls by exactly the
    // append height (the Chrome-only anchor bug, traced live).
    pending: null as null | { id: number; pos: number },
  });

  useLayoutEffect(() => {
    // Hidden feed: every measurement is 0/0, so scrolling and the
    // too-short auto-fetch would misbehave (the auto-fetch condition
    // `scrollHeight <= clientHeight` is trivially true and would
    // chain-load the whole history invisibly). Skip while inactive —
    // SSE appends just sit in the DOM until the module is shown again —
    // and remember it so the next visible run restores the reader.
    if (!active) {
      wasHidden.current = true;
      return;
    }
    const el = ref.current;
    if (!el) return;
    const reShow = wasHidden.current;
    wasHidden.current = false;
    const firstId = msgs[0]?.id ?? 0;
    const a = anchor.current;
    let scrolled = false;
    if (a.key !== resetKey) {
      el.scrollTo({ top: el.scrollHeight });
      a.pending = null;
      scrolled = true;
    } else if (firstId < a.firstId && a.atBottom) {
      // Older page landed while the reader is at the bottom (they scrolled
      // down while the load was in flight): follow the bottom instead of the
      // anchored restore — restoring would yank them back up to where they
      // were at trigger time, undoing the scroll they just made.
      el.scrollTo({ top: el.scrollHeight });
      a.pending = null;
      scrolled = true;
    } else if (a.pending && firstId < a.firstId) {
      // Older page landed: put the anchored message back where the reader
      // last saw it — immune to SSE appends that grew the bottom meanwhile.
      // This is also the R2b re-show path: an older-page load in flight at
      // hide time whose prepend landed while hidden (sequence: hide →
      // prepend lands, layout effect gated → re-show → the anchored
      // message goes back at its recorded viewport position; a.firstId is
      // still the pre-prepend value because the hidden runs were gated).
      const node = el.querySelector(`[data-id="${a.pending.id}"]`);
      if (node) el.scrollTop = (node as HTMLElement).offsetTop - a.pending.pos;
      a.pending = null;
      scrolled = true;
    } else if (firstId > a.firstId || (firstId === a.firstId && a.atBottom)) {
      // New view, or appends while the reader was at the bottom: follow.
      el.scrollTo({ top: el.scrollHeight });
      a.pending = null;
      scrolled = true;
    }
    // Re-show restore: display:none zeroed scrollTop. When a pending
    // element anchor fired above (or the reader was following the bottom)
    // the branches already put them back; otherwise restore their exact
    // recorded offset.
    if (reShow && !scrolled && !a.atBottom) el.scrollTop = lastScroll.current;
    // If the view has more history but isn't scrollable yet (short pages),
    // auto-fetch once so the scroll-to-load trigger stays reachable.
    if (el.scrollHeight <= el.clientHeight && hasMore && !loadingOlder) onLoadOlder?.();
    anchor.current = {
      key: resetKey,
      firstId,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 4,
      pending: a.pending,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs, resetKey, hasMore, loadingOlder, active]);

  const onScroll = () => {
    // Queued/synthetic scroll events must not measure or fetch while the
    // feed is hidden (display:none zeroes every measurement).
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    lastScroll.current = el.scrollTop;
    // F5: keep bottom-position current between renders — the layout effect
    // reads this at append time, so a reader who scrolled up after the last
    // render isn't yanked back down by a stale atBottom=true.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    anchor.current.atBottom = atBottom;
    // Pending-anchor rebase: an older-page load is in flight and the reader
    // may keep scrolling. Zones: trigger zone = scrollTop <= 2 (topmost —
    // rebase records the same values, a no-op); reading zone = everything
    // above the bottom zone (re-pin the anchor to the reader's CURRENT
    // first message + pos, so the prepend restores where they are NOW);
    // bottom zone = atBottom, same <4px threshold as F5 (they're done
    // reading up — drop the anchor so the prepend becomes a no-op and the
    // layout effect just follows the bottom).
    const a = anchor.current;
    // First VISIBLE message (the reader's actual reading position) — the
    // DOM-first element can sit above the viewport when the view
    // auto-fetched a long list; anchoring an invisible element restores a
    // wrong position.
    const top = el.getBoundingClientRect().top;
    const firstVisible = (el.querySelector('[data-id]') as HTMLElement | null) &&
      ([...el.querySelectorAll('[data-id]')] as HTMLElement[]).find(
        (b) => b.getBoundingClientRect().bottom >= top,
      );
    const pos = firstVisible
      ? Math.round(firstVisible.getBoundingClientRect().top - top)
      : null;
    if (a.pending) {
      if (atBottom) {
        a.pending = null;
      } else if (firstVisible && pos !== null) {
        a.pending = { id: Number(firstVisible.dataset.id), pos };
      }
    }
    if (el.scrollTop <= 2 && hasMore && !loadingOlder) {
      a.pending = firstVisible && pos !== null
        ? { id: Number(firstVisible.dataset.id), pos }
        : null;
      onLoadOlder?.();
    }
  };

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="relative flex flex-1 flex-col overflow-y-auto bg-gray-50 p-3.5 dark:bg-[#1a1a1a]"
    >
      <div className="mb-1 flex justify-center text-[10px] text-gray-500 dark:text-gray-400">
        {loadingOlder ? (
          <span className="animate-pulse">⟳ loading earlier messages…</span>
        ) : msgs.length > 0 && !hasMore ? (
          <span>— beginning of conversation —</span>
        ) : null}
      </div>
      {msgs.length === 0 ? (
        <div className="m-auto text-gray-600 dark:text-gray-400">
          {ready ? 'No messages for this view yet.' : '⟳ loading…'}
        </div>
      ) : (
        msgs.map((m) => <MessageBubble key={m.id} m={m} directional={directional} />)
      )}
    </div>
  );
}
