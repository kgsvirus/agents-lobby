import { Message, hh } from '../data/api';

// flip: in the Boss view the boss is the counterpart → left; human (you) stays right.
export function MessageBubble({ m, flip }: { m: Message; flip?: boolean }) {
  const kind = m.from === 'boss' ? 'boss' : m.from === 'human' ? 'human' : 'agent';
  const right = kind === 'human' || (kind === 'boss' && !flip);
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
    <div
      className={`mb-2.5 w-fit max-w-[70%] whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 ${
        right
          ? 'ml-auto rounded-br-sm text-right'
          : 'mr-auto rounded-bl-sm'
      } ${
        kind === 'boss'
          ? 'bg-blue-900/80'
          : kind === 'human'
            ? 'bg-emerald-700'
            : 'bg-gray-200 dark:bg-[#2a2a2a]'
      }`}
    >
      <div
        className={`mb-0.5 text-[10px] ${
          kind === 'boss'
            ? 'text-blue-300'
            : kind === 'human'
              ? 'text-emerald-200'
              : 'text-green-600 dark:text-green-400'
        }`}
      >
        {meta}
      </div>
      {m.text}
    </div>
  );
}
