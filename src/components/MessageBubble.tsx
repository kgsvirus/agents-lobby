import { Message, hh } from '../data/api';

// Alignment is fixed by sender identity: Human (you) floats right in every
// view; agents and the boss float left. The sender label sits above the
// bubble, aligned to the same direction.
export function MessageBubble({ m }: { m: Message }) {
  const kind = m.from === 'boss' ? 'boss' : m.from === 'human' ? 'human' : 'agent';
  const right = kind === 'human';
  const meta =
    kind === 'boss' ? (
      <>
        Boss · {hh(m.time)}
        {m.to && <b> → {m.to}</b>}
      </>
    ) : kind === 'human' ? (
      <>
        Human · {hh(m.time)}
        {m.to && m.to !== 'boss' && <b> → {m.to}</b>}
      </>
    ) : (
      <>
        {m.from} · {hh(m.time)}
      </>
    );
  return (
    <div className={`mb-2.5 flex w-fit max-w-[70%] flex-col ${right ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
      <div
        className={`mb-0.5 text-[10px] ${
          kind === 'boss'
            ? 'text-blue-600 dark:text-blue-400'
            : kind === 'human'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-green-700 dark:text-green-400'
        }`}
      >
        {meta}
      </div>
      <div
        className={`w-fit whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 ${
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
