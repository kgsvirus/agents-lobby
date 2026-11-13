import { Agent, Message, View, hh, projectGroups } from '../data/api';
import { ThemeToggle } from './ThemeToggle';
import { Theme } from '../hooks/useTheme';

interface Props {
  agents: Agent[];
  msgs: Message[];
  view: View;
  expanded: Set<string>;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onToggleExpand: (project: string) => void;
  onSelect: (view: View, el: HTMLElement) => void;
}

export function Sidebar({
  agents,
  msgs,
  view,
  expanded,
  theme,
  onTheme,
  onToggleExpand,
  onSelect,
}: Props) {
  const groups = projectGroups(agents);
  const lastFor = (names: string[]) => {
    const own = msgs.filter((m) => names.includes(m.from));
    return own.length ? hh(own[own.length - 1].time) : '';
  };

  const active = (v: View) =>
    v.kind === view.kind && ('name' in v ? (view as { name: string }).name === v.name : true)
      ? 'bg-blue-700/40'
      : 'hover:bg-gray-200 dark:hover:bg-gray-700';

  return (
    <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-300 bg-gray-100 p-2.5 dark:border-gray-700 dark:bg-[#181818]">
      <div className="mb-2.5 flex items-center justify-between">
        <h1 className="text-sm font-bold text-gray-900 dark:text-white">
          Agents-Lobby
        </h1>
        <ThemeToggle theme={theme} onSelect={onTheme} />
      </div>
      <div
        onClick={(e) => onSelect({ kind: 'boss' }, e.currentTarget)}
        className={`row cursor-pointer rounded-md px-2 py-1.5 ${active({ kind: 'boss' })}`}
      >
        <b>Boss</b>
        <span className="text-[11px] text-gray-500">
          {msgs.filter((m) => m.from === 'human').length
            ? ` — ${hh(msgs.filter((m) => m.from === 'human').slice(-1)[0].time)}`
            : ''}
        </span>
      </div>
      <div
        onClick={(e) => onSelect({ kind: 'all' }, e.currentTarget)}
        className={`row cursor-pointer rounded-md px-2 py-1.5 ${active({ kind: 'all' })}`}
      >
        <b>All projects</b>
      </div>
      {Object.entries(groups).map(([project, list]) => (
        <div key={project}>
          <div
            className={`row flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 ${active({ kind: 'project', name: project })}`}
            onClick={(e) => onSelect({ kind: 'project', name: project }, e.currentTarget)}
          >
            <span
              className="text-gray-500"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(project);
              }}
            >
              {expanded.has(project) ? '▾' : '▸'}
            </span>
            <b>{project}</b>
            <span className="text-[11px] text-gray-500">— {lastFor(list.map((a) => a.name))}</span>
          </div>
          {list.map((a) => (
            <div
              key={a.name}
              className={`row cursor-pointer rounded-md py-1 pl-7 text-xs ${active({ kind: 'agent', name: a.name })}`}
              style={{ display: expanded.has(project) ? 'block' : 'none' }}
              onClick={(e) => onSelect({ kind: 'agent', name: a.name }, e.currentTarget)}
            >
              {a.name}{' '}
              <span className="text-[11px] text-gray-500">— {lastFor([a.name])}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
