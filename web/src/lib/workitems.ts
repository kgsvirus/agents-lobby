// Seeded work items — sample data for the Projects module only, until a real
// work-item store exists. Deterministic (no randomness) so the board is stable
// across reloads. Replace this module with the API client when the store lands.
export const STATUSES = [
  'To do',
  'On-going',
  'Ready for testing',
  'Testing',
  'For approval',
  'Done',
] as const;

export type Status = (typeof STATUSES)[number];

export type WorkItem = {
  id: string;
  title: string;
  agent: string;
  tag: string;
  status: Status;
};

// Per phase, per status. Some columns are deliberately empty.
const COUNTS: number[][] = [
  [3, 2, 1, 0, 0, 4],
  [2, 1, 2, 1, 0, 3],
  [1, 3, 0, 2, 1, 2],
  [0, 2, 1, 1, 2, 4],
  [4, 0, 0, 1, 0, 1],
  [3, 1, 0, 0, 0, 0],
  [2, 0, 1, 1, 0, 2],
  [1, 0, 0, 0, 0, 0],
];

export const PHASE_COUNTS: number[] = COUNTS.map((row) => row.reduce((a, b) => a + b, 0));
export const TOTAL_COUNT = PHASE_COUNTS.reduce((a, b) => a + b, 0);

const TAGS = ['spec', 'ui', 'api', 'docs', 'qa', 'infra'];
const FALLBACK_AGENTS = ['coordinator', 'developer', 'reviewer', 'devops'];

const TITLES: Record<Status, string[]> = {
  'To do': [
    'Define the agent registry contract',
    'Session re-bind runbook',
    'Phase plan for v1',
    'Spec the work-item API',
  ],
  'On-going': [
    'Dashboard layout pass',
    'Conversation previews',
    'Board scaffold',
    'Token mapping cleanup',
  ],
  'Ready for testing': [
    'Markdown rendering in bubbles',
    'Empty states',
    'Rail keyboard navigation',
  ],
  Testing: ['Sidebar collapse persistence', 'Composer gating'],
  'For approval': ['shadcn shell + tokens', 'Move to E: (NTFS)'],
  Done: [
    'lucide icons + keyboard access',
    'Component test layer',
    'Phases scaffold',
    'Docs refresh',
  ],
};

// Items for one project phase. Agents come from the project's registered
// agents so the Agent filter matches reality.
export function seedWorkItems(
  project: string,
  phaseIndex: number,
  agentNames: string[],
): WorkItem[] {
  const counts = COUNTS[phaseIndex % COUNTS.length];
  const agents = agentNames.length > 0 ? agentNames : FALLBACK_AGENTS;
  const items: WorkItem[] = [];

  STATUSES.forEach((status, si) => {
    const pool = TITLES[status];
    for (let i = 0; i < counts[si]; i += 1) {
      items.push({
        id: `${project}:${phaseIndex}:${status}:${i}`,
        title: pool[(i + phaseIndex) % pool.length],
        agent: agents[i % agents.length],
        tag: TAGS[(i + phaseIndex) % TAGS.length],
        status,
      });
    }
  });

  return items;
}

export const WORK_ITEM_TAGS = TAGS;
