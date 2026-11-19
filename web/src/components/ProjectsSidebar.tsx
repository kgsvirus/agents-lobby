import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, LayoutGrid } from 'lucide-react';
import type { Agent } from '../lib/api';
import { hh } from '../lib/api';
import { PHASES } from '../lib/phases';
import { PHASE_COUNTS } from '../lib/workitems';

interface Props {
  projects: string[];
  agents: Agent[];
  lastActivity: Record<string, string | null>;
  selected: string | null;
  selectedPhase: number;
  expanded: Set<string>;
  onToggleExpand: (project: string) => void;
  onSelect: (project: string, phase: number) => void;
}

// Projects → phases. The chevron sits at the far right of the project row
// (it replaced the old "N agents" label); phases are indented under it and
// selecting one swaps the flow board.
export function ProjectsNav({
  projects,
  agents,
  lastActivity,
  selected,
  selectedPhase,
  expanded,
  onToggleExpand,
  onSelect,
}: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const agentsOf = (project: string) => agents.filter((a) => a.project === project);
  const stampOf = (project: string) => {
    // /api/last-activity has no project:* keys — aggregate the project's agents.
    const ts = agentsOf(project)
      .map((a) => lastActivity[`agent:${a.name}`] ?? '')
      .filter(Boolean)
      .sort()
      .slice(-1)[0];
    return ts ? hh(ts) : '';
  };

  const rowClass = (active: boolean) =>
    `flex w-full items-start gap-2 border-b border-border py-2.5 pr-2 pl-3.5 text-left transition-colors hover:bg-accent ${
      active ? 'bg-accent shadow-[inset_2px_0_0_var(--primary)]' : ''
    }`;

  const visible = projects.filter((p) => !q || p.toLowerCase().includes(q) || PHASES.some((ph) => ph.toLowerCase().includes(q)));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3.5">
        <h2 className="text-sm font-semibold text-foreground">Projects</h2>
        <span className="ml-auto text-[11px] text-muted-foreground">{projects.length}</span>
      </div>

      <div className="px-3 pt-3 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search projects and phases…"
          className="h-8 w-full rounded-lg border border-border bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {(!q || 'all'.includes(q)) && (
          <button
            type="button"
            onClick={() => onSelect('', 0)}
            className={`${rowClass(selected === null)} cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none`}
          >
            <LayoutGrid size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-foreground">ALL</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                Every project on this machine
              </span>
            </span>
          </button>
        )}

        {visible.map((project) => {
          const open = expanded.has(project);
          const list = agentsOf(project);
          const active = selected === project;
          return (
            <div key={project}>
              <div className={rowClass(active)}>
                <button
                  type="button"
                  onClick={() => onSelect(project, 0)}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                >
                  <Folder size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-foreground">
                      {project}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {list.length > 0
                        ? `${list.length} agent${list.length === 1 ? '' : 's'} · last activity ${stampOf(project) || '—'}`
                        : 'No agents registered'}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onToggleExpand(project)}
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${project}`}
                  className="mt-0.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                >
                  <ChevronDown
                    size={14}
                    className={`transition-transform ${open ? '' : '-rotate-90'}`}
                  />
                </button>
              </div>

              {open && (
                <div className="mr-2 mb-1.5 ml-5 border-l border-border pl-1.5">
                  {PHASES.filter((ph) => !q || ph.toLowerCase().includes(q) || project.toLowerCase().includes(q)).map(
                    (label) => {
                      // Index must come from the full list: filtering hides rows,
                      // it must not renumber phases or point at the wrong one.
                      const index = PHASES.indexOf(label);
                      const phaseActive = active && selectedPhase === index;
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => onSelect(project, index)}
                          className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-accent focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
                            phaseActive
                              ? 'bg-accent text-foreground shadow-[inset_2px_0_0_var(--primary)]'
                              : 'text-muted-foreground'
                          }`}
                        >
                          <span className="truncate">
                            Phase {index + 1} · {label}
                          </span>
                          <span className="ml-auto shrink-0 text-[10px]">
                            {PHASE_COUNTS[index]}
                          </span>
                        </button>
                      );
                    },
                  )}
                </div>
              )}
            </div>
          );
        })}

        {visible.length === 0 && (
          <p className="px-3.5 py-6 text-xs text-muted-foreground">
            {projects.length === 0 ? 'No projects found.' : 'No matches.'}
          </p>
        )}
      </div>
    </div>
  );
}
