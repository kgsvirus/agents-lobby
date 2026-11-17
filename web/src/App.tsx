'use client';
import { useEffect, useState } from 'react';
import { Agent, View, fetchAgents, fetchLastActivity, fetchLocalProjects } from './lib/api';
import { useMessages, viewKey } from './hooks/useMessages';
import { useTheme } from './hooks/useTheme';
import { TopNav, Module } from './components/TopNav';
import { Sidebar } from './components/Sidebar';
import { ProjectsSidebar } from './components/ProjectsSidebar';
import { ChatFeed } from './components/ChatFeed';
import { Composer } from './components/Composer';

// Client-side only (static export; no SSR data fetching, no Server Actions,
// no db access — decision 2). Sidebar collapse state is read in a mount
// effect, not in the initializer: the page is prerendered at build time, so
// render-path localStorage access would break the export (and hydration).
export default function App() {
  const [module, setModule] = useState<Module>('chat');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [view, setView] = useState<View>({ kind: 'boss' });
  // Sidebar groups: expanded by default (empty collapsed set on first
  // load); the user's collapse choices persist across load/reload.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [lastActivity, setLastActivity] = useState<Record<string, string | null>>({});
  const [localProjects, setLocalProjects] = useState<string[]>([]);
  const [projectSelection, setProjectSelection] = useState<string | null>(null);
  const { feed, loadOlder, recents } = useMessages(view, agents);
  const [theme, selectTheme] = useTheme();

  useEffect(() => {
    try {
      const saved = localStorage.getItem('lobby.sidebar.collapsed');
      if (saved) setCollapsed(new Set(JSON.parse(saved) as string[]));
    } catch {
      /* storage unavailable — default expanded */
    }
  }, []);

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => setAgents([]));
    // Store-backed sidebar stamps: one fetch on load, no polling.
    fetchLastActivity().then(setLastActivity).catch(() => {});
    // /api/local-projects is a guaranteed compat route (decision 2); the catch
    // is graceful degradation for GENUINE failures (e.g. readdir error → 500).
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
      {/* Chat stays MOUNTED but hidden across module round-trips: this
          preserves ChatFeed reading position and the Composer draft.
          Projects/Office remain plain conditional mounts. */}
      <div
        className="flex min-h-0 flex-1"
        style={module === 'chat' ? undefined : { display: 'none' }}
      >
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
              <span className="text-[18px] font-bold text-gray-900 dark:text-white">
                {title}
              </span>
            </div>
            <ChatFeed
              active={module === 'chat'}
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
