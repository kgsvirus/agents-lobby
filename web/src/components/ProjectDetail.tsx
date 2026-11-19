'use client';

import { Agent, hh } from '../lib/api';
import { PHASES } from '../lib/phases';
import { TOTAL_COUNT, seedWorkItems } from '../lib/workitems';
import { Button } from './ui/button';
import { FlowBoard } from './FlowBoard';

// Projects detail: page header, metrics strip, and one flow board for the
// selected phase. Work items have no source yet, so the two data metrics show
// what we can honestly compute.
export function ProjectDetail({
  project,
  phaseIndex,
  agents,
  lastActivity,
}: {
  project: string | null;
  phaseIndex: number;
  agents: Agent[];
  lastActivity: Record<string, string | null>;
}) {
  if (project === null) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center">
          <p className="text-sm font-semibold">Select a project</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a folder on the left, then a phase, to open its flow board.
          </p>
        </div>
      </div>
    );
  }

  const projectAgents = agents.filter((a) => a.project === project);
  // /api/last-activity has no project:* keys — aggregate the project's agents.
  const stamp = projectAgents
    .map((a) => lastActivity[`agent:${a.name}`] ?? '')
    .filter(Boolean)
    .sort()
    .slice(-1)[0];
  const phaseLabel = PHASES[phaseIndex] ?? PHASES[0];

  const items = seedWorkItems(project, phaseIndex, projectAgents.map((a) => a.name));
  // Items fall back to stand-in agents when a project has none registered; the
  // filter must use those same names or every card gets filtered out.
  const agentNames =
    projectAgents.length > 0
      ? projectAgents.map((a) => a.name)
      : Array.from(new Set(items.map((i) => i.agent)));

  const metrics = [
    { label: 'Agents', value: String(projectAgents.length) },
    { label: 'Phases', value: String(PHASES.length) },
    { label: 'Work items', value: String(TOTAL_COUNT) },
    { label: 'Last activity', value: stamp ? hh(stamp) : '—' },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-foreground">{project}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {projectAgents.length} agent{projectAgents.length === 1 ? '' : 's'} · last activity{' '}
            {stamp ? hh(stamp) : '—'}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled title="Not wired yet">
            Open folder
          </Button>
          <Button size="sm" disabled title="Not wired yet">
            Add agent
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="truncate text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
              {m.label}
            </div>
            <div className="mt-0.5 text-[17px] font-semibold text-foreground">{m.value}</div>
          </div>
        ))}
      </div>

      <FlowBoard
        key={project}
        phaseIndex={phaseIndex}
        phaseLabel={phaseLabel}
        agentNames={agentNames}
        items={items}
      />
    </div>
  );
}
