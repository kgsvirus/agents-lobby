import { useMemo, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Folder, LayoutGrid } from 'lucide-react';
import { Agent, Message, View, hh, projectGroups } from '../lib/api';

interface Props {
  agents: Agent[];
  recents: Message[];
  lastActivity: Record<string, string | null>;
  view: View;
  collapsed: Set<string>;
  onToggleExpand: (project: string) => void;
  onSelect: (view: View) => void;
}

// Two-line rows: name + time, then the last message as a preview. This is the
// list column of the approved layout; the rail next to it carries the modules.
export function ChatNav({
  agents,
  recents,
  lastActivity,
  view,
  collapsed,
  onToggleExpand,
  onSelect,
}: Props) {
  const [query, setQuery] = useState('');
  const groups = projectGroups(agents);

  const stampOf = (key: string, names: string[]): string => {
    const fromAgents = names
      .map((n) => lastActivity[`agent:${n}`] ?? '')
      .filter(Boolean)
      .sort()
      .slice(-1)[0];
    const ts =
      lastActivity[key] ??
      fromAgents ??
      recents.filter((m) => names.includes(m.from)).slice(-1)[0]?.time ??
      null;
    return ts ? hh(ts) : '';
  };

  const lastFor = (pred: (m: Message) => boolean): Message | undefined =>
    recents.filter(pred).slice(-1)[0];

  const preview = (m: Message | undefined, fallback: string): string => {
    if (!m) return fallback;
    const text = m.text.replace(/[`*>#]/g, '').replace(/\s+/g, ' ').trim();
    const body = text.length > 150 ? `${text.slice(0, 150)}…` : text;
    return `${m.from === 'human' ? 'You' : m.from}: ${body}`;
  };

  const bossMsg = lastFor((m) => m.from === 'boss' || m.from === 'human');
  const allMsg = recents.slice(-1)[0];
  const bossStamp = stampOf('boss', []);

  const isActive = (v: View) =>
    v.kind === view.kind && ('name' in v ? (view as { name: string }).name === v.name : true);

  const q = query.trim().toLowerCase();
  const rowClass = (active: boolean) =>
    `w-full cursor-pointer border-b border-border px-3.5 py-2.5 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
      active ? 'bg-accent shadow-[inset_2px_0_0_var(--primary)]' : ''
    }`;

  const visibleGroups = Object.entries(groups).filter(([project, list]) => {
    if (!q) return true;
    return (
      project.toLowerCase().includes(q) ||
      list.some((a) => a.name.toLowerCase().includes(q))
    );
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3.5">
        <h2 className="text-sm font-semibold text-foreground">Conversations</h2>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {Object.keys(groups).length}
        </span>
      </div>

      <div className="px-3 pt-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations…"
          className="h-8 w-full rounded-lg border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {(!q || 'boss'.includes(q)) && (
          <button
            type="button"
            onClick={() => onSelect({ kind: 'boss' })}
            className={rowClass(isActive({ kind: 'boss' }))}
          >
            <span className="flex items-baseline gap-2">
              <Bot size={14} className="shrink-0 self-center text-muted-foreground" />
              <span className="text-[13px] font-semibold text-foreground">Boss</span>
              <span className="ml-auto text-[11px] text-muted-foreground">{bossStamp}</span>
            </span>
            <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted-foreground">
              {preview(bossMsg, 'No messages yet')}
            </span>
          </button>
        )}

        {(!q || 'all projects'.includes(q)) && (
          <button
            type="button"
            onClick={() => onSelect({ kind: 'all' })}
            className={rowClass(isActive({ kind: 'all' }))}
          >
            <span className="flex items-baseline gap-2">
              <LayoutGrid size={14} className="shrink-0 self-center text-muted-foreground" />
              <span className="text-[13px] font-semibold text-foreground">All projects</span>
            </span>
            <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted-foreground">
              {preview(allMsg, 'No messages yet')}
            </span>
          </button>
        )}

        {visibleGroups.map(([project, list]) => {
          const isCollapsed = collapsed.has(project);
          const agentsOf = list.filter((a) => !q || a.name.toLowerCase().includes(q) || project.toLowerCase().includes(q));
          return (
            <div key={project}>
              <div className={rowClass(isActive({ kind: 'project', name: project }))}>
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => onToggleExpand(project)}
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${project}`}
                    className="mt-0.5 grid size-5 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelect({ kind: 'project', name: project })}
                    className="min-w-0 flex-1 cursor-pointer text-left"
                  >
                    <span className="flex items-baseline gap-2">
                      <Folder size={14} className="shrink-0 self-center text-muted-foreground" />
                      <span className="truncate text-[13px] font-semibold text-foreground">
                        {project}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {stampOf(`project:${project}`, list.map((a) => a.name))}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[12px] text-muted-foreground">
                      {preview(
                        lastFor((m) => list.some((a) => a.name === m.from)),
                        'No messages yet',
                      )}
                    </span>
                  </button>
                </div>
              </div>

              {!isCollapsed && agentsOf.length > 0 && (
                <div className="mr-3 mb-1.5 ml-[26px] border-l border-border pl-1.5">
                  {agentsOf.map((a) => (
                    <button
                      key={a.name}
                      type="button"
                      onClick={() => onSelect({ kind: 'agent', name: a.name })}
                      className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
                        isActive({ kind: 'agent', name: a.name })
                          ? 'bg-accent text-foreground shadow-[inset_2px_0_0_var(--primary)]'
                          : 'text-muted-foreground'
                      }`}
                    >
                      <span className="truncate">{a.name}</span>
                      <span className="ml-auto shrink-0 text-[11px]">
                        {stampOf(`agent:${a.name}`, [a.name])}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
