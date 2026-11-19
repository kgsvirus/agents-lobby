'use client';

import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from './ui/button';
import {
  STATUSES,
  WORK_ITEM_TAGS,
  type Status,
  type WorkItem,
} from '../lib/workitems';

// Flow board for one phase. Items are seeded sample data (lib/workitems.ts)
// until the work-item store lands; the header controls already filter them.
export function FlowBoard({
  phaseIndex,
  phaseLabel,
  agentNames,
  items,
}: {
  phaseIndex: number;
  phaseLabel: string;
  agentNames: string[];
  items: WorkItem[];
}) {
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState(false);
  const [status, setStatus] = useState<Set<string>>(() => new Set(STATUSES));
  const [agents, setAgents] = useState<Set<string>>(() => new Set(agentNames));
  const [tags, setTags] = useState<Set<string>>(() => new Set(WORK_ITEM_TAGS));

  const activeCount = useMemo(
    () =>
      STATUSES.length -
      status.size +
      (agentNames.length - agents.size) +
      (WORK_ITEM_TAGS.length - tags.size),
    [status, agents, tags, agentNames.length],
  );

  const q = query.trim().toLowerCase();
  const visible = items.filter(
    (it) =>
      status.has(it.status) &&
      agents.has(it.agent) &&
      tags.has(it.tag) &&
      (!q || it.title.toLowerCase().includes(q)),
  );

  const toggle = (set: Set<string>, value: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    next.has(value) ? next.delete(value) : next.add(value);
    apply(next);
  };

  const clear = () => {
    setQuery('');
    setStatus(new Set(STATUSES));
    setAgents(new Set(agentNames));
    setTags(new Set(WORK_ITEM_TAGS));
  };

  const visibleStatuses = STATUSES.filter((s) => status.has(s));

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold">
          <span className="size-[7px] shrink-0 rounded-full bg-green-500 ring-3 ring-green-500/15" />
          <span className="shrink-0">Flow board</span>
          <span className="truncate font-normal text-muted-foreground">
            · Phase {phaseIndex + 1} — {phaseLabel}
          </span>
          <span
            className="shrink-0 rounded-full border border-border px-1.5 text-[10px] font-normal text-muted-foreground"
            title="Seeded sample data until the work-item store lands"
          >
            sample
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative w-[210px] shrink-0">
            <svg
              className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter work items…"
              className="h-7 w-full rounded-md border border-border bg-background pr-2 pl-7 text-[11.5px] text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            />
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setPanel((p) => !p)}
              aria-expanded={panel}
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[11.5px] text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            >
              Filter: {activeCount === 0 ? 'all' : activeCount}
              <ChevronDown size={11} />
            </button>

            {panel && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setPanel(false)} />
                <div className="absolute top-full right-0 z-50 mt-1.5 max-h-[430px] w-60 overflow-auto rounded-lg border border-border bg-card p-1.5 shadow-xl">
                  <Group label="Status">
                    {STATUSES.map((s) => (
                      <Check
                        key={s}
                        label={s}
                        checked={status.has(s)}
                        onChange={() => toggle(status, s, setStatus)}
                      />
                    ))}
                  </Group>
                  <Group label="Agent">
                    {agentNames.length === 0 ? (
                      <p className="px-1 text-[11px] text-muted-foreground">No agents registered</p>
                    ) : (
                      agentNames.map((a) => (
                        <Check
                          key={a}
                          label={a}
                          checked={agents.has(a)}
                          onChange={() => toggle(agents, a, setAgents)}
                        />
                      ))
                    )}
                  </Group>
                  <Group label="Tag">
                    {WORK_ITEM_TAGS.map((t) => (
                      <Check
                        key={t}
                        label={t}
                        checked={tags.has(t)}
                        onChange={() => toggle(tags, t, setTags)}
                      />
                    ))}
                  </Group>
                </div>
              </>
            )}
          </div>

          <span className="text-[11px] whitespace-nowrap text-muted-foreground">
            {visible.length} items
          </span>
          <Button variant="ghost" size="sm" onClick={clear} className="h-7 px-2 text-[11.5px]">
            Clear
          </Button>
        </div>
      </div>

      <div className="grid min-w-0 flex-1 auto-cols-[minmax(178px,1fr)] grid-flow-col gap-2 overflow-x-auto p-2.5">
        {visibleStatuses.map((s: Status) => {
          const inColumn = visible.filter((it) => it.status === s);
          return (
            <section
              key={s}
              className="flex min-h-[180px] flex-col gap-2 rounded-lg border border-border bg-background p-2"
            >
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.04em] text-foreground uppercase">
                {s}
                <span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                  {inColumn.length}
                </span>
              </h3>
              {inColumn.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-1.5 py-3.5 text-center text-[10.5px] text-muted-foreground">
                  No items
                </div>
              ) : (
                inColumn.map((it) => (
                  <div
                    key={it.id}
                    className="rounded-md border border-border bg-card px-2 py-2"
                  >
                    <p className="text-[11.5px] leading-snug font-semibold text-foreground">
                      {it.title}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">{it.agent}</p>
                    <span className="mt-1.5 inline-block rounded-full border border-border px-1.5 text-[9.5px] text-muted-foreground">
                      {it.tag}
                    </span>
                  </div>
                ))
              )}
            </section>
          );
        })}
        {visibleStatuses.length === 0 && (
          <p className="p-6 text-xs text-muted-foreground">Every status is filtered out.</p>
        )}
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col px-1 py-1.5 [&+&]:border-t [&+&]:border-border">
      <div className="mb-1 text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11.5px] hover:bg-accent">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="size-3.5 accent-blue-600"
      />
      {label}
    </label>
  );
}
