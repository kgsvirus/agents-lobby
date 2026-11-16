import { useEffect, useState } from 'react';
import { Agent, View, fetchAgents, fetchLastActivity, fetchLocalProjects } from './data/api';
import { useMessages, viewKey } from './hooks/useMessages';
import { useTheme } from './hooks/useTheme';
import { TopNav, Module } from './components/TopNav';
import { Sidebar } from './components/Sidebar';
import { ProjectsSidebar } from './components/ProjectsSidebar';
import { ChatFeed } from './components/ChatFeed';
import { Composer } from './components/Composer';

export default function App() {
  const [module, setModule] = useState<Module>('chat');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [view, setView] = useState<View>({ kind: 'boss' });
  // Sidebar groups: expanded by default (empty collapsed set on first
  // load); the user's collapse choices persist across load/reload.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('lobby.sidebar.collapsed');
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [lastActivity, setLastActivity] = useState<Record<string, string | null>>({});
  const [localProjects, setLocalProjects] = useState<string[]>([]);
  const [projectSelection, setProjectSelection] = useState<string | null>(null);
  const { feed, loadOlder, recents } = useMessages(view, agents);
  const [theme, selectTheme] = useTheme();

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => setAgents([]));
    // Store-backed sidebar stamps: one fetch on load, no polling.
    fetchLastActivity().then(setLastActivity).catch(() => {});
    fetchLocalProjects().then(setLocalProjects).catch(() => setLocalProjects([]));
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
    <div className="flex h-screen flex-col bg-gray-50 font-sans text-gray-900 dark:bg-[#111] dark:text-gray-200">
      <TopNav module={module} onModule={setModule} theme={theme} onTheme={selectTheme} />
      {module === 'chat' && (
        <div className="flex min-h-0 flex-1">
          <Sidebar
            agents={agents}
            recents={recents}
            lastActivity={lastActivity}
            view={view}
            collapsed={collapsed}
            onToggleExpand={(p) =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                next.has(p) ? next.delete(p) : next.add(p);
                try {
                  localStorage.setItem('lobby.sidebar.collapsed', JSON.stringify([...next]));
                } catch {
                  /* storage unavailable — session-only */
                }
                return next;
              })
            }
            onSelect={(v) => setView(v)}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center bg-gray-100 px-3 py-2 dark:bg-[#161616]">
              <span className="text-xs font-bold text-gray-900 dark:text-white">
                {title}
              </span>
            </div>
            <ChatFeed
              msgs={feed.messages}
              directional={view.kind !== 'boss'}
              loadingOlder={feed.loadingOlder}
              hasMore={feed.hasMore}
              ready={feed.ready}
              onLoadOlder={loadOlder}
              resetKey={viewKey(view)}
            />
            <Composer
              key={`${view.kind}:${'name' in view ? view.name : ''}`}
              agents={agents}
              view={view}
              onSent={() => fetchAgents().then(setAgents)}
            />
          </div>
        </div>
      )}
      {module === 'projects' && (
        <div className="flex min-h-0 flex-1">
          <ProjectsSidebar
            projects={localProjects}
            selected={projectSelection}
            onSelect={setProjectSelection}
          />
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center text-gray-600 dark:text-gray-400">
            {projectSelection
              ? `Projects — ${projectSelection}`
              : 'Projects — select a project'}
          </div>
        </div>
      )}
      {module === 'office' && (
        <div className="flex min-h-0 flex-1 items-center justify-center text-gray-600 dark:text-gray-400">
          Office — coming soon
        </div>
      )}
    </div>
  );
}
