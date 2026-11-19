import { Bot, ChevronDown, ChevronRight, Folder, LayoutGrid } from 'lucide-react';
import { Agent, Message, View, hh, projectGroups } from '../lib/api';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from './ui/sidebar';

interface Props {
  agents: Agent[];
  recents: Message[];
  lastActivity: Record<string, string | null>;
  view: View;
  collapsed: Set<string>;
  onToggleExpand: (project: string) => void;
  onSelect: (view: View, el: HTMLElement) => void;
}

// Chat module navigation. Rendered inside the shadcn Sidebar, so every row is
// a real button with sidebar-aware focus/hover states and an icon-only rail.
export function ChatNav({
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

  const select = (v: View) => (e: React.MouseEvent<HTMLElement>) =>
    onSelect(v, e.currentTarget as HTMLElement);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={isActive({ kind: 'boss' })} tooltip="Boss" onClick={select({ kind: 'boss' })}>
          <Bot />
          <span>Boss</span>
          {bossStamp !== '' && (
            <span className="ml-auto text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">
              {bossStamp}
            </span>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>

      <SidebarMenuItem>
        <SidebarMenuButton isActive={isActive({ kind: 'all' })} tooltip="All projects" onClick={select({ kind: 'all' })}>
          <LayoutGrid />
          <span>All projects</span>
        </SidebarMenuButton>
      </SidebarMenuItem>

      {Object.entries(groups).map(([project, list]) => {
        const s = stamp(`project:${project}`, list.map((a) => a.name));
        const isCollapsed = collapsed.has(project);
        const projectView: View = { kind: 'project', name: project };
        return (
          <SidebarMenuItem key={project}>
            <div className="relative">
              <SidebarMenuButton
                isActive={isActive(projectView)}
                tooltip={project}
                onClick={select(projectView)}
                className="pr-8 group-data-[collapsible=icon]:pr-2"
              >
                <Folder />
                <span>{project}</span>
                {s !== '' && (
                  <span className="ml-auto text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">
                    {s}
                  </span>
                )}
              </SidebarMenuButton>
              <button
                type="button"
                onClick={() => onToggleExpand(project)}
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${project}`}
                className="absolute top-1/2 right-1 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none group-data-[collapsible=icon]:hidden"
              >
                {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
            </div>
            {!isCollapsed && (
              <SidebarMenuSub>
                {list.map((a) => {
                  const as = stamp(`agent:${a.name}`, [a.name]);
                  return (
                    <SidebarMenuSubItem key={a.name}>
                      <SidebarMenuSubButton
                        render={<button type="button" />}
                        isActive={isActive({ kind: 'agent', name: a.name })}
                        onClick={select({ kind: 'agent', name: a.name })}
                      >
                        <span className="truncate">{a.name}</span>
                        {as !== '' && (
                          <span className="ml-auto text-[11px] text-muted-foreground">{as}</span>
                        )}
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  );
                })}
              </SidebarMenuSub>
            )}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
