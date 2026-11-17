import type { Message } from '../lib/api';
import { bubbleMeta } from '../lib/api';

// Alignment is fixed by sender identity (see bubbleMeta in lib/api.ts):
// Human (you) floats right in every view; agents and the boss float left.
// Sender label sits above the bubble in both alignments.
export function MessageBubble({
  m,
  directional,
}: {
  m: Message;
  directional?: boolean;
}) {
  const { kind, right, meta } = bubbleMeta(m, directional ?? false);
  return (
    <div data-id={m.id} className={`mb-2.5 flex w-fit max-w-[70%] flex-col ${right ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
      <div
        className={`mb-0.5 text-[10px] ${
          kind === 'boss'
            ? 'text-blue-600 dark:text-blue-400'
            : kind === 'human'
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-green-700 dark:text-green-400'
        }`}
      >
        {meta}
      </div>
      <div
        className={`w-fit whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 text-[15px] ${
          right ? 'rounded-tr-sm' : 'rounded-tl-sm'
        } ${
          kind === 'boss'
            ? 'bg-blue-900 text-white'
            : kind === 'human'
              ? 'bg-emerald-700 text-white'
              : 'bg-gray-100 text-gray-900 dark:bg-[#2a2a2a] dark:text-gray-200'
        }`}
      >
        {m.text}
      </div>
    </div>
  );
}
