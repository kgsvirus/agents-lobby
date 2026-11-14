// All data access and view-model helpers live in this single file.

export interface Agent {
  name: string;
  project: string;
}

export interface Message {
  id: number;
  time: string; // ISO timestamp
  from: string; // agent name or "boss"
  to: string | null; // comma-separated agent names or "all"
  text: string;
}

export type View =
  | { kind: 'all' }
  | { kind: 'boss' }
  | { kind: 'project'; name: string }
  | { kind: 'agent'; name: string };

export const fetchAgents = async (): Promise<Agent[]> =>
  (await fetch('/api/agents')).json();

// Maps a View to the bridge's view param: all | boss | agent:<name> | project:<name>.
export const viewParam = (view: View | null): string | null => {
  if (view === null) return null;
  if (view.kind === 'agent') return `agent:${view.name}`;
  if (view.kind === 'project') return `project:${view.name}`;
  return view.kind; // 'all' | 'boss'
};

export const fetchMessages = async (
  view: View | null = null,
  after = 0,
  limit = 500,
): Promise<Message[]> => {
  const params = new URLSearchParams({
    after: String(after),
    limit: String(limit),
  });
  const viewValue = viewParam(view);
  if (viewValue !== null) params.set('view', viewValue);
  return (await fetch(`/api/messages?${params}`)).json();
};

export const sendMessage = async (
  to: string[] | 'all',
  message: string,
  from: 'human' | 'boss' = 'boss',
): Promise<{ sent: string[]; skipped: string[]; error?: string }> =>
  (
    await fetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message, from }),
    })
  ).json();

// Webchat: prompt the boss (like typing in the desktop session).
export const promptBoss = async (
  message: string,
): Promise<{ status: string; error?: string }> =>
  (
    await fetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
  ).json();

export const hh = (iso: string): string =>
  new Date(iso).toTimeString().slice(0, 5);

export const involves = (m: Message, name: string): boolean =>
  m.from === name || m.to === 'all' || (m.to ?? '').split(', ').includes(name);

export const isVisible = (m: Message, view: View, agents: Agent[]): boolean => {
  if (view.kind === 'all') return true;
  // Boss view: my replies + prompts/sends actually addressed to the boss.
  // Human: direct sends to agents (to: <agent>) bypass the boss by design.
  if (view.kind === 'boss') return m.from === 'boss' || m.to === 'boss';
  if (view.kind === 'agent') return involves(m, view.name);
  return agents
    .filter((a) => a.project === view.name)
    .some((a) => involves(m, a.name));
};

export const defaultTargets = (view: View, agents: Agent[]): string[] => {
  if (view.kind === 'agent') return [view.name];
  if (view.kind === 'project')
    return agents.filter((a) => a.project === view.name).map((a) => a.name);
  if (view.kind === 'all') return agents.map((a) => a.name);
  return [];
};

export const projectGroups = (agents: Agent[]): Record<string, Agent[]> => {
  const groups: Record<string, Agent[]> = {};
  agents.forEach((a) => (groups[a.project] = (groups[a.project] ?? []).concat(a)));
  return groups;
};
