'use client';
import { useEffect, useState } from 'react';
import { Agent, View, fetchAgents, fetchLastActivity, fetchLocalProjects } from './lib/api';
import { useMessages, viewKey } from './hooks/useMessages';
import { useTheme } from './hooks/useTheme';
import { ContentBar } from './components/ContentBar';
import { Rail, type Module } from './components/Rail';
import { ChatNav } from './components/Sidebar';
import { ProjectsNav } from './components/ProjectsSidebar';
import { ProjectDetail } from './components/ProjectDetail';
import { ChatFeed } from './components/ChatFeed';
import { Composer } from './components/Composer';
import { Sidebar, SidebarContent, SidebarInset, SidebarProvider } from './components/ui/sidebar';
import { PHASES } from './lib/phases';

// Client-side only (static export; no SSR data fetching, no Server Actions,
// no db access — decision 2). Sidebar collapse state is read in a mount
// effect, not in the initializer: the page is prerendered at build time, so
// render-path localStorage access would break the export (and hydration).
export default function App() {
  const [module, setModule] = useState<Module>('chat');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [view, setView] = useState<View>({ kind: 'boss' });
  // Chat list: expanded by default (empty collapsed set on first load); the
  // user's collapse choices persist across load/reload.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [lastActivity, setLastActivity] = useState<Record<string, string | null>>({});
  const [localProjects, setLocalProjects] = useState<string[]>([]);
  // Projects module selection: project name + phase index.
  const [project, setProject] = useState<string | null>(null);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [projectsExpanded, setProjectsExpanded] = useState<Set<string>>(() => new Set());
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

  const crumbs =
    module === 'chat'
      ? ['Chat room', title]
      : module === 'projects'
        ? ['Projects', project ?? 'ALL', `Phase ${phaseIndex + 1}`]
        : ['Office'];

  return (
    <SidebarProvider className="h-svh overflow-hidden" style={{ '--sidebar-width': '20rem' } as React.CSSProperties}>
      <Rail module={module} onModule={setModule} theme={theme} onTheme={selectTheme} />

      <Sidebar collapsible="offcanvas">
        <SidebarContent className="gap-0 overflow-hidden p-0">
          {module === 'chat' && (
            <ChatNav
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
          )}
          {module === 'projects' && (
            <ProjectsNav
              projects={localProjects}
              agents={agents}
              lastActivity={lastActivity}
              selected={project}
              selectedPhase={phaseIndex}
              expanded={projectsExpanded}
              onToggleExpand={(p) =>
                setProjectsExpanded((prev) => {
                  const next = new Set(prev);
                  next.has(p) ? next.delete(p) : next.add(p);
                  return next;
                })
              }
              onSelect={(p, phase) => {
                if (p === '') {
                  setProject(null);
                  setPhaseIndex(0);
                  return;
                }
                setProject(p);
                setPhaseIndex(Math.min(phase, PHASES.length - 1));
                setProjectsExpanded((prev) => new Set(prev).add(p));
              }}
            />
          )}
        </SidebarContent>
      </Sidebar>

      <SidebarInset className="min-h-0 min-w-0">
        <ContentBar crumbs={crumbs} />

        {/* Chat stays MOUNTED but hidden across module round-trips: this
            preserves ChatFeed reading position and the Composer draft. */}
        <div
          className="flex min-h-0 flex-1"
          style={module === 'chat' ? undefined : { display: 'none' }}
        >
          <div className="flex min-w-0 flex-1 flex-col">
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
          <ProjectDetail
            project={project}
            phaseIndex={phaseIndex}
            agents={agents}
            lastActivity={lastActivity}
          />
        )}

        {module === 'office' && (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center">
              <p className="text-sm font-semibold">Office</p>
              <p className="mt-1 text-sm text-muted-foreground">Coming soon.</p>
            </div>
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
