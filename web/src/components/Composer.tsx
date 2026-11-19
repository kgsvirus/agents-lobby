import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Send } from 'lucide-react';
import {
  Agent,
  ApiError,
  View,
  composeTarget,
  defaultTargets,
  promptBoss,
  sendMessage,
} from '../lib/api';
import { Button } from './ui/button';

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

  // Escape closes the recipient picker, like the settings menu in TopNav.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

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
  const defaults = defaultTargets(view, agents);
  const fullDefault =
    defaults.length > 0 &&
    picked.size === defaults.length &&
    [...picked].every((p) => defaults.includes(p));
  const canSend = bossMode || picked.size > 0;
  const label = bossMode
    ? 'boss'
    : allMode
      ? 'all projects'
      : view.kind === 'project' && fullDefault
        ? view.name
        : [...picked].join(', ');

  // Errors surface the shared envelope's message via ApiError (standing
  // Phase 6 ruling): read error.message, never the raw envelope object.
  const submit = async () => {
    const body = text.trim();
    if (!body || !canSend) return;
    const action = composeTarget(view, picked);
    try {
      if (action.kind === 'prompt') await promptBoss(body);
      else await sendMessage(action.to, body, 'human');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      return;
    }
    setError('');
    setText('');
    onSent();
  };

  return (
    <div className="relative border-t border-gray-300 bg-gray-100 p-2.5 dark:border-gray-700 dark:bg-[#161616]">
      {error && <div className="pb-1 text-right text-[10px] text-red-700 dark:text-red-500">{error}</div>}
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
          <Button
            ref={pickerRef}
            variant="ghost"
            onClick={toggle}
            disabled={bossMode}
            aria-haspopup="menu"
            aria-expanded={open}
            className={`gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-[inherit] text-gray-900 hover:bg-white dark:border-gray-700 dark:bg-[#222] dark:text-gray-200 dark:hover:bg-[#222] ${
              bossMode ? 'cursor-not-allowed opacity-50' : ''
            }`}
          >
            To: {label} <ChevronDown size={14} className="shrink-0" />
          </Button>
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
          <Button
            onClick={submit}
            disabled={!canSend}
            className={`rounded-lg px-4 py-1.5 font-[inherit] ${
              canSend ? '' : 'cursor-not-allowed opacity-50'
            }`}
          >
            <Send size={14} className="shrink-0" /> Send
          </Button>
        </div>
      </div>
    </div>
  );
}
