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

export interface MessagePage {
  messages: Message[];
  hasMore: boolean; // more rows exist in the fetch direction (upward: older remain)
}

export const fetchMessages = async (
  view: View | null = null,
  opts: { after?: number; before?: number; limit?: number } = {},
): Promise<MessagePage> => {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 10),
  });
  if (opts.after) params.set('after', String(opts.after));
  if (opts.before) params.set('before', String(opts.before));
  const viewValue = viewParam(view);
  if (viewValue !== null) params.set('view', viewValue);
  return (await fetch(`/api/messages?${params}`)).json();
};

// SSE: the bridge pushes every new message row the moment it lands in
// the store. Returns the EventSource so the caller can close it on
// unmount; its auto-reconnect is the safety net (on reconnect, catch
// up with after=<newestId> so nothing is missed).
export const subscribeStream = (onRow: (m: Message) => void): EventSource => {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try {
      onRow(JSON.parse(e.data) as Message);
    } catch {
      /* ignore malformed frames */
    }
  };
  return es;
};

// Store-backed last-activity stamps (F6): { all, boss, "agent:<name>" } → ISO ts.
// One fetch on load; project views aggregate their agents client-side.
export const fetchLastActivity = async (): Promise<Record<string, string | null>> =>
  (await fetch('/api/last-activity')).json();

export const fetchLocalProjects = async (): Promise<string[]> =>
  (await fetch('/api/local-projects')).json();

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
