import { Bot, ChevronDown, ChevronRight, LayoutGrid } from 'lucide-react';
import { Agent, Message, View, hh, projectGroups } from '../lib/api';

interface Props {
  agents: Agent[];
  recents: Message[];
  lastActivity: Record<string, string | null>;
  view: View;
  collapsed: Set<string>;
  onToggleExpand: (project: string) => void;
  onSelect: (view: View, el: HTMLElement) => void;
}

// Shared row shape: real buttons, so the whole navigation is keyboard reachable.
const ROW =
  'row cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

export function Sidebar({
  agents,
  recents,
  lastActivity,
  view,
  collapsed,
  onToggleExpand,
  onSelect,
}: Props) {
  const groups = projectGroups(agents);
  // Store-backed last-activity (F6): the /api/last-activity map is the source
  // of truth; the recents window (SSE-updated) is only a fallback when the
  // map lacks the key. Project rows aggregate their agents' stamps.
  const stamp = (key: string, names: string[]): string => {
    const ts =
      lastActivity[key] ??
      names
        .map((n) => lastActivity[`agent:${n}`] ?? '')
        .filter(Boolean)
        .sort()
        .slice(-1)[0] ??
      (recents.filter((m) => names.includes(m.from)).slice(-1)[0]?.time ?? null);
    return ts ? hh(ts) : '';
  };
  const bossStamp = (() => {
    const ts =
      lastActivity['boss'] ??
      (recents.filter((m) => m.from === 'human').slice(-1)[0]?.time ?? null);
    return ts ? hh(ts) : '';
  })();

  const isActive = (v: View) =>
    v.kind === view.kind && ('name' in v ? (view as { name: string }).name === v.name : true);
  const active = (v: View) =>
    isActive(v) ? 'bg-blue-700/40' : 'hover:bg-gray-200 dark:hover:bg-gray-700';

  return (
    <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-300 bg-gray-100 p-2.5 dark:border-gray-700 dark:bg-[#181818]">
      <button
        type="button"
        onClick={(e) => onSelect({ kind: 'boss' }, e.currentTarget)}
        aria-current={isActive({ kind: 'boss' }) || undefined}
        className={`${ROW} flex w-full items-center gap-1.5 px-2 py-1.5 text-left ${active({ kind: 'boss' })}`}
      >
        <Bot size={14} className="shrink-0 text-gray-600 dark:text-gray-400" />
        <b>Boss</b>
        <span className="text-[11px] text-gray-600 dark:text-gray-400">
          {bossStamp ? ` — ${bossStamp}` : ''}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => onSelect({ kind: 'all' }, e.currentTarget)}
        aria-current={isActive({ kind: 'all' }) || undefined}
        className={`${ROW} flex w-full items-center gap-1.5 px-2 py-1.5 text-left ${active({ kind: 'all' })}`}
      >
        <LayoutGrid size={14} className="shrink-0 text-gray-600 dark:text-gray-400" />
        <b>All projects</b>
      </button>
      {Object.entries(groups).map(([project, list]) => {
        const s = stamp(`project:${project}`, list.map((a) => a.name));
        const isCollapsed = collapsed.has(project);
        return (
          <div key={project}>
            <div
              className={`${ROW} flex items-center gap-1 px-2 py-1.5 ${active({ kind: 'project', name: project })}`}
            >
              <button
                type="button"
                onClick={() => onToggleExpand(project)}
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${project}`}
                className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-gray-600 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-white"
              >
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
              <button
                type="button"
                onClick={(e) => onSelect({ kind: 'project', name: project }, e.currentTarget)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left focus-visible:outline-none"
              >
                <b>{project}</b>
                <span className="text-[11px] text-gray-600 dark:text-gray-400">
                  {s ? ` — ${s}` : ''}
                </span>
              </button>
            </div>
            {list.map((a) => {
              const as = stamp(`agent:${a.name}`, [a.name]);
              return (
                <button
                  key={a.name}
                  type="button"
                  className={`${ROW} block w-full py-1 pl-7 text-left text-xs ${active({ kind: 'agent', name: a.name })}`}
                  style={{ display: isCollapsed ? 'none' : 'block' }}
                  onClick={(e) => onSelect({ kind: 'agent', name: a.name }, e.currentTarget)}
                >
                  {a.name}{' '}
                  <span className="text-[11px] text-gray-600 dark:text-gray-400">
                    {as ? ` — ${as}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
