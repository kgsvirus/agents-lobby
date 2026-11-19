'use client';
import { useEffect, useState } from 'react';
import { Agent, View, fetchAgents, fetchLastActivity, fetchLocalProjects } from './lib/api';
import { useMessages, viewKey } from './hooks/useMessages';
import { useTheme } from './hooks/useTheme';
import { TopNav, Module } from './components/TopNav';
import { ChatNav } from './components/Sidebar';
import { ProjectsNav } from './components/ProjectsSidebar';
import { ChatFeed } from './components/ChatFeed';
import { Composer } from './components/Composer';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from './components/ui/sidebar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './components/ui/breadcrumb';

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

  const moduleLabel = module === 'chat' ? 'Chat room' : module === 'projects' ? 'Projects' : 'Office';

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="icon">
        <SidebarHeader className="border-b border-sidebar-border px-2 py-2">
          <span className="truncate px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase group-data-[collapsible=icon]:hidden">
            {moduleLabel}
          </span>
        </SidebarHeader>
        <SidebarContent>
          {module === 'chat' && (
            <SidebarGroup>
              <SidebarGroupLabel>Conversations</SidebarGroupLabel>
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
            </SidebarGroup>
          )}
          {module === 'projects' && (
            <SidebarGroup>
              <SidebarGroupLabel>Folders</SidebarGroupLabel>
              <ProjectsNav
                projects={localProjects}
                selected={projectSelection}
                onSelect={setProjectSelection}
              />
            </SidebarGroup>
          )}
        </SidebarContent>
      </Sidebar>

      <SidebarInset className="min-h-0">
        <TopNav module={module} onModule={setModule} theme={theme} onTheme={selectTheme} />

        {/* Chat stays MOUNTED but hidden across module round-trips: this
            preserves ChatFeed reading position and the Composer draft.
            Projects/Office remain plain conditional mounts. */}
        <div
          className="flex min-h-0 flex-1"
          style={module === 'chat' ? undefined : { display: 'none' }}
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem className="hidden md:block">
                    <span className="text-muted-foreground">Chat room</span>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden md:block" />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
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
            <iframe src="/ui/mockups/kanban-board-mockup.html" title="Mockup" style={{ flex: 1 }}></iframe>
          </div>
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
