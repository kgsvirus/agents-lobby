import { useEffect, useState } from 'react';
import { Message, fetchMessages } from '../data/api';

// Polls the bridge every 5s; messages are appended-only so polling is enough.
export function useMessages(): Message[] {
  const [msgs, setMsgs] = useState<Message[]>([]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await fetchMessages();
        if (alive) setMsgs(next);
      } catch {
        /* bridge down — keep last known state */
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
