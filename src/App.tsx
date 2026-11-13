import { useEffect, useState } from 'react';
import { Agent, View, fetchAgents, isVisible } from './data/api';
import { useMessages } from './hooks/useMessages';
import { useTheme } from './hooks/useTheme';
import { Sidebar } from './components/Sidebar';
import { ChatFeed } from './components/ChatFeed';
import { Composer } from './components/Composer';
import { ThemeToggle } from './components/ThemeToggle';

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [view, setView] = useState<View>({ kind: 'boss' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const msgs = useMessages();
  const [theme, selectTheme] = useTheme();

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  const title =
    view.kind === 'all'
      ? 'All projects'
      : view.kind === 'boss'
        ? 'Boss'
        : view.kind === 'project'
          ? view.name
          : `${view.name} — ${agents.find((a) => a.name === view.name)?.project ?? ''}`;

  return (
    <div className="flex h-screen bg-gray-50 font-sans text-gray-900 dark:bg-[#111] dark:text-gray-200">
      <Sidebar
        agents={agents}
        msgs={msgs}
        view={view}
        expanded={expanded}
        theme={theme}
        onTheme={selectTheme}
        onToggleExpand={(p) =>
          setExpanded((prev) => {
            const next = new Set(prev);
            next.has(p) ? next.delete(p) : next.add(p);
            return next;
          })
        }
        onSelect={(v, el) => {
          setView(v);
          document
            .querySelectorAll('.row')
            .forEach((r) => r.classList.remove('active'));
          el.classList.add('active');
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center bg-gray-100 px-3 py-2 dark:bg-[#161616]">
          <span className="text-xs font-bold text-gray-900 dark:text-white">
            {title}
          </span>
        </div>
        <ChatFeed
          msgs={msgs.filter((m) => isVisible(m, view, agents))}
          flip={view.kind === 'boss'}
        />
        <Composer
          key={`${view.kind}:${'name' in view ? view.name : ''}`}
          agents={agents}
          view={view}
          onSent={() => fetchAgents().then(setAgents)}
        />
      </div>
    </div>
  );
}
