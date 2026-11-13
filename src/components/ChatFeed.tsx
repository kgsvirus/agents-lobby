import { useEffect, useRef } from 'react';
import { Message } from '../data/api';
import { MessageBubble } from './MessageBubble';

export function ChatFeed({ msgs }: { msgs: Message[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [msgs]);

  return (
    <div
      ref={ref}
      className="flex flex-1 flex-col overflow-y-auto bg-gray-50 p-3.5 dark:bg-[#1a1a1a]"
    >
      {msgs.length === 0 ? (
        <div className="m-auto text-gray-500">No messages for this view yet.</div>
      ) : (
        msgs.map((m, i) => <MessageBubble key={`${m.time}-${i}`} m={m} />)
      )}
    </div>
  );
}
