import { useRef, useState } from 'react';
import {
  Agent,
  View,
  defaultTargets,
  promptBoss,
  sendMessage,
} from '../data/api';

interface Props {
  agents: Agent[];
  view: View;
  onSent: () => void;
}

// Remounted per view (keyed in App): the picker starts at the view's targets.
export function Composer({ agents, view, onSent }: Props) {
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(defaultTargets(view, agents)),
  );
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const pickerRef = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    if (!open && pickerRef.current) {
      const r = pickerRef.current.getBoundingClientRect();
      // Fixed positioning: the menu floats above everything, bottom-anchored to the picker.
      setPos({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 4 });
    }
    setOpen(!open);
  };

  // Boss view: compose always prompts the boss — the picker is disabled and
  // submit is forced to promptBoss even if picked somehow holds targets.
  // All view: all agents pre-selected (direct `Human:` broadcast).
  // Project/agent views: direct `Human:` send to the picked agents; an empty
  // selection disables Send.
  const bossMode = view.kind === 'boss';
  const allMode = view.kind === 'all' && picked.size === agents.length;
  const canSend = bossMode || picked.size > 0;
  const label = bossMode
    ? 'boss'
    : allMode
      ? 'all projects'
      : [...picked].join(', ');

  const submit = async () => {
    const body = text.trim();
    if (!body || !canSend) return;
    const res = bossMode
      ? await promptBoss(body)
      : await sendMessage(picked.size ? [...picked] : 'all', body, 'human');
    if (res.error) return setError(res.error);
    setError('');
    setText('');
    onSent();
  };

  return (
    <div className="relative border-t border-gray-300 bg-gray-100 p-2.5 dark:border-gray-700 dark:bg-[#161616]">
      {error && <div className="pb-1 text-right text-[10px] text-red-500">{error}</div>}
      <div className="flex gap-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="Type a message…"
          className="min-h-[calc(1.45em*3+16px)] flex-1 resize-y rounded-lg border border-gray-300 bg-white px-2.5 py-2 font-[inherit] text-gray-900 dark:border-gray-700 dark:bg-[#222] dark:text-gray-200"
        />
        <div className="relative flex flex-col gap-1.5">
          {open && <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />}
          <button
            ref={pickerRef}
            onClick={toggle}
            disabled={bossMode}
            className={`rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-[inherit] text-gray-900 dark:border-gray-700 dark:bg-[#222] dark:text-gray-200 ${
              bossMode ? 'cursor-not-allowed opacity-50' : ''
            }`}
          >
            To: {label} ▾
          </button>
          {open && pos && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div
                className="fixed z-50 min-w-[200px] rounded-lg border border-gray-700 bg-gray-100 p-1.5 shadow-lg dark:bg-[#222]"
                style={{ right: pos.right, bottom: pos.bottom }}
              >
              {(view.kind === 'project'
                ? agents.filter((a) => a.project === view.name)
                : view.kind === 'agent'
                  ? agents.filter((a) => a.name === view.name)
                  : agents
              ).map((a) => (
                <label
                  key={a.name}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-gray-200 dark:hover:bg-[#2a2a2a]"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={picked.has(a.name)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      e.target.checked ? next.add(a.name) : next.delete(a.name);
                      setPicked(next);
                    }}
                  />
                  <span>
                    {a.name}
                    <span className="block text-[10px] text-gray-600 dark:text-gray-400">{a.project}</span>
                  </span>
                </label>
              ))}
              </div>
            </>
          )}
          <button
            onClick={submit}
            disabled={!canSend}
            className={`rounded-lg bg-blue-600 px-4 py-1.5 font-[inherit] text-white hover:bg-blue-500 ${
              canSend ? '' : 'cursor-not-allowed opacity-50'
            }`}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
