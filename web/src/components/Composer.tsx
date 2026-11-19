import { useState } from 'react';
import { ChevronDown, LoaderCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
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
import { Checkbox } from './ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

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
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

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
  const canSend = (bossMode || picked.size > 0) && !sending;
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
    setSending(true);
    try {
      if (action.kind === 'prompt') await promptBoss(body);
      else await sendMessage(action.to, body, 'human');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
      setSending(false);
      return;
    }
    setSending(false);
    setText('');
    onSent();
  };

  const toggleTarget = (name: string, checked: boolean) => {
    const next = new Set(picked);
    checked ? next.add(name) : next.delete(name);
    setPicked(next);
  };

  return (
    <div className="border-t border-border bg-sidebar p-2.5">
      <div className="flex gap-1.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          placeholder="Type a message…"
          className="min-h-[calc(1.45em*3+16px)] flex-1 resize-y rounded-lg border border-border bg-background px-2.5 py-2 font-[inherit] text-foreground"
        />
        <div className="relative flex flex-col gap-1.5">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  disabled={bossMode}
                  aria-label={`Recipients: ${label}`}
                  className={`gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[inherit] text-foreground hover:bg-muted ${
                    bossMode ? 'cursor-not-allowed opacity-50' : ''
                  }`}
                />
              }
            >
              To: {label} <ChevronDown size={14} className="shrink-0" />
            </PopoverTrigger>
            <PopoverContent align="end" side="top" className="w-64 p-1.5">
              {(view.kind === 'project'
                ? agents.filter((a) => a.project === view.name)
                : view.kind === 'agent'
                  ? agents.filter((a) => a.name === view.name)
                  : agents
              ).map((a) => (
                <label
                  key={a.name}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-muted"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={picked.has(a.name)}
                    onCheckedChange={(checked) => toggleTarget(a.name, checked === true)}
                  />
                  <span>
                    {a.name}
                    <span className="block text-[10px] text-muted-foreground">{a.project}</span>
                  </span>
                </label>
              ))}
            </PopoverContent>
          </Popover>
          <Button
            onClick={() => void submit()}
            disabled={!canSend}
            className={`rounded-lg px-4 py-1.5 font-[inherit] ${
              canSend ? '' : 'cursor-not-allowed opacity-50'
            }`}
          >
            {sending ? (
              <LoaderCircle size={14} className="shrink-0 animate-spin" />
            ) : (
              <Send size={14} className="shrink-0" />
            )}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
