import { Agent, Message, View, hh, projectGroups } from '../data/api';

interface Props {
  agents: Agent[];
  recents: Message[];
  lastActivity: Record<string, string | null>;
  view: View;
  collapsed: Set<string>;
  onToggleExpand: (project: string) => void;
  onSelect: (view: View, el: HTMLElement) => void;
}

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

  const active = (v: View) =>
    v.kind === view.kind && ('name' in v ? (view as { name: string }).name === v.name : true)
      ? 'bg-blue-700/40'
      : 'hover:bg-gray-200 dark:hover:bg-gray-700';

  return (
    <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-300 bg-gray-100 p-2.5 dark:border-gray-700 dark:bg-[#181818]">
      <div
        onClick={(e) => onSelect({ kind: 'boss' }, e.currentTarget)}
        className={`row cursor-pointer rounded-md px-2 py-1.5 ${active({ kind: 'boss' })}`}
      >
        <b>Boss</b>
        <span className="text-[11px] text-gray-600 dark:text-gray-400">
          {bossStamp ? ` — ${bossStamp}` : ''}
        </span>
      </div>
      <div
        onClick={(e) => onSelect({ kind: 'all' }, e.currentTarget)}
        className={`row cursor-pointer rounded-md px-2 py-1.5 ${active({ kind: 'all' })}`}
      >
        <b>All projects</b>
      </div>
      {Object.entries(groups).map(([project, list]) => {
        const s = stamp(`project:${project}`, list.map((a) => a.name));
        return (
        <div key={project}>
          <div
            className={`row flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 ${active({ kind: 'project', name: project })}`}
            onClick={(e) => onSelect({ kind: 'project', name: project }, e.currentTarget)}
          >
            <span
              className="text-gray-600 dark:text-gray-400"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(project);
              }}
            >
              {!collapsed.has(project) ? '▾' : '▸'}
            </span>
            <b>{project}</b>
            <span className="text-[11px] text-gray-600 dark:text-gray-400">
              {s ? ` — ${s}` : ''}
            </span>
          </div>
          {list.map((a) => {
            const as = stamp(`agent:${a.name}`, [a.name]);
            return (
            <div
              key={a.name}
              className={`row cursor-pointer rounded-md py-1 pl-7 text-xs ${active({ kind: 'agent', name: a.name })}`}
              style={{ display: !collapsed.has(project) ? 'block' : 'none' }}
              onClick={(e) => onSelect({ kind: 'agent', name: a.name }, e.currentTarget)}
            >
              {a.name}{' '}
              <span className="text-[11px] text-gray-600 dark:text-gray-400">
                {as ? ` — ${as}` : ''}
              </span>
            </div>
            );
          })}
        </div>
        );
      })}
    </div>
  );
}
