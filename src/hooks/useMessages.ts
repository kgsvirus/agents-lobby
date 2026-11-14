import { useEffect, useRef, useState } from 'react';
import { Message, fetchMessages } from '../data/api';

// Polls the bridge every 5s; fetches only rows newer than the last seen id
// and appends them, so history is never refetched.
export function useMessages(): Message[] {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const lastId = useRef(0);
  const have = useRef(new Set<number>());

  useEffect(() => {
    let alive = true;
    let busy = false; // a slow fetch must not overlap the next tick (no dupes)
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await fetchMessages(null, lastId.current, 500);
        if (!alive || next.length === 0) return;
        const fresh = next.filter((m) => !have.current.has(m.id));
        if (fresh.length === 0) return;
        lastId.current = fresh[fresh.length - 1].id;
        have.current = new Set([
          ...have.current,
          ...fresh.map((m) => m.id),
        ]);
        setMsgs((prev) => [...prev, ...fresh]);
      } catch {
        /* bridge down — keep last known state */
      } finally {
        busy = false;
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return msgs;
}
