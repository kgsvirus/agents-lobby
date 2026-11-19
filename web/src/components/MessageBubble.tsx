import type { Message } from '../lib/api';
import { bubbleMeta } from '../lib/api';
import { Markdown } from './Markdown';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

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
  const metaTone =
    kind === 'boss'
      ? 'text-blue-600 dark:text-blue-400'
      : kind === 'human'
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-green-700 dark:text-green-400';

  return (
    <div
      data-id={m.id}
      className={`mb-3 flex w-fit max-w-[78%] flex-col ${right ? 'ml-auto items-end' : 'mr-auto items-start'}`}
    >
      <div className="mb-0.5 flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger render={<span className={`cursor-default text-[10px] ${metaTone}`} />}>
            {meta}
          </TooltipTrigger>
          <TooltipContent>{new Date(m.time).toLocaleString()}</TooltipContent>
        </Tooltip>
      </div>
      <div
        className={`w-fit max-w-full whitespace-normal break-words rounded-xl px-3 py-2 text-[13.5px] leading-relaxed ${
          right ? 'rounded-tr-sm' : 'rounded-tl-sm'
        } ${
          kind === 'boss'
            ? 'bg-blue-900 text-white'
            : kind === 'human'
              ? 'bg-emerald-700 text-white'
              : 'bg-gray-100 text-gray-900 dark:bg-[#2a2a2a] dark:text-gray-200'
        }`}
      >
        <Markdown text={m.text} />
      </div>
    </div>
  );
}
