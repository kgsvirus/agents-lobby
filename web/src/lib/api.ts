// All data access and view-model helpers live in this single file
// (ported from the legacy src/data/api.ts — behavior source for the rebuild).
//
// Transport changes vs. the legacy app (Phase 6 adaptation):
//   - Every request goes through `requestJson`, which maps the new server's
//     shared error envelope { error: { code, message } } to an ApiError whose
//     message is the envelope's message (the legacy client read `error` as a
//     plain string; the standing Phase 6 ruling requires envelope adaptation).
//   - SSE moved from the bridge's /api/stream (data-only frames) to the new
//     backend's GET /api/events: named `message.created` frames carrying the
//     wire message row. `agent.status_changed` / `project.updated` frames and
//     heartbeat comments are ignored (no UI consumes them today). Reconnect
//     catch-up rides on the native EventSource Last-Event-ID header — the
//     server replays persisted events id > cursor — while the hook's
//     after=<newestId> REST catch-up on open mirrors the legacy flow.

// Same-origin relative URLs (static /ui at cutover, dev rewrites locally).
// NEXT_PUBLIC_LOBBY_API_BASE overrides for dev against a remote backend.
export const API_BASE = process.env.NEXT_PUBLIC_LOBBY_API_BASE ?? '';

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

// Maps a View to the server's view param: all | boss | agent:<name> | project:<name>.
export const viewParam = (view: View | null): string | null => {
  if (view === null) return null;
  if (view.kind === 'agent') return `agent:${view.name}`;
  if (view.kind === 'project') return `project:${view.name}`;
  return view.kind; // 'all' | 'boss'
};

// Shared error envelope reader (standing ruling): accepts the new shape
// { error: { code, message } } and, defensively, the legacy plain-string
// { error: "..." } body. Non-JSON / unrecognized bodies get a generic message.
export const readErrorEnvelope = (
  body: unknown,
): { code: string; message: string } | null => {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === 'string') return { code: 'error', message: err };
    if (err !== null && typeof err === 'object') {
      const { code, message } = err as { code?: unknown; message?: unknown };
      if (typeof message === 'string') {
        return { code: typeof code === 'string' ? code : 'error', message };
      }
    }
  }
  return null;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${API_BASE}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    /* non-JSON body — handled below via the status check */
  }
  if (!res.ok) {
    const envelope = readErrorEnvelope(body);
    throw new ApiError(
      res.status,
      envelope?.code ?? 'error',
      envelope?.message ?? `Request failed (${res.status})`,
    );
  }
  return body as T;
};

export const fetchAgents = async (): Promise<Agent[]> => requestJson<Agent[]>('/api/agents');

// --- Human identity ----------------------------------------------------------
// Identity mode (peer-auth.json present): the server mints a loopback session
// cookie, so the browser connects with no paste; the token is only used in
// shared-token mode, where it is pasted once. The token lives in sessionStorage
// and is never baked into the bundle; same-origin JavaScript can read it (XSS),
// which the accepted local trust model already covers.
const HUMAN_TOKEN_KEY = 'lobby.humanToken';
const DISCONNECTED_KEY = 'lobby.disconnected';

export const getHumanToken = (): string | null => {
  try {
    return window.sessionStorage.getItem(HUMAN_TOKEN_KEY);
  } catch {
    return null;
  }
};

export const setHumanToken = (token: string | null): void => {
  try {
    if (token === null || token === '') window.sessionStorage.removeItem(HUMAN_TOKEN_KEY);
    else window.sessionStorage.setItem(HUMAN_TOKEN_KEY, token);
  } catch {
    /* storage unavailable (private mode): sends stay unauthenticated */
  }
};

/** True when this tab deliberately disconnected (a reload must not re-connect). */
export const isDisconnected = (): boolean => {
  try {
    return window.sessionStorage.getItem(DISCONNECTED_KEY) === '1';
  } catch {
    return false;
  }
};

export const setDisconnected = (value: boolean): void => {
  try {
    if (value) window.sessionStorage.setItem(DISCONNECTED_KEY, '1');
    else window.sessionStorage.removeItem(DISCONNECTED_KEY);
  } catch {
    /* ignore */
  }
};

/** Headers for a write call: JSON plus the pasted token, when one exists. The
 *  browser session rides on the cookie automatically (same origin). */
const writeHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getHumanToken();
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return headers;
};

export interface Principal {
  name: string;
  kind: 'human' | 'boss' | 'agent';
}

export type AuthMode = 'identity' | 'shared-token' | 'open';

export const fetchAuthMode = async (): Promise<AuthMode> =>
  (await requestJson<{ mode: AuthMode }>('/api/auth-mode')).mode;

/** Loopback auto-connect: mints the browser session cookie. The JSON content
 *  type and the `x-lobby-connect` header are deliberate - a cross-site form can
 *  send neither (forms cannot set headers, and `text/plain` is rejected by the
 *  route), so a hostile page cannot mint or clear a session. */
export const connectBrowser = async (): Promise<Principal> => {
  const principal = await requestJson<Principal>('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lobby-connect': '1' },
    body: '{}',
  });
  setDisconnected(false);
  return principal;
};

export const disconnectBrowser = async (): Promise<void> => {
  setDisconnected(true);
  await requestJson<{ status: string }>('/api/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lobby-connect': '1' },
    body: '{}',
  });
};

/** Verifies the current identity without sending a message. */
export const fetchPrincipal = async (): Promise<Principal> => {
  const headers = writeHeaders();
  return requestJson<Principal>('/api/principal', { headers });
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
  return requestJson<MessagePage>(`/api/messages?${params}`);
};

// SSE: the server pushes every new message row the moment it lands in the
// store. Returns the EventSource so the caller can close it on unmount; its
// auto-reconnect is the safety net (on reconnect it sends Last-Event-ID and
// the server replays missed events; the hook additionally catches up with
// after=<newestId> on open).
export const subscribeStream = (onRow: (m: Message) => void): EventSource => {
  const es = new EventSource(`${API_BASE}/api/events`);
  es.addEventListener('message.created', (e) => {
    try {
      onRow(JSON.parse((e as MessageEvent).data) as Message);
    } catch {
      /* ignore malformed frames */
    }
  });
  return es;
};

// Store-backed last-activity stamps: { all, boss, "agent:<name>" } → ISO ts.
// One fetch on load; project views aggregate their agents client-side.
export const fetchLastActivity = async (): Promise<Record<string, string | null>> =>
  requestJson<Record<string, string | null>>('/api/last-activity');

export const fetchLocalProjects = async (): Promise<string[]> =>
  requestJson<string[]>('/api/local-projects');

/** One automatic reconnect when a write is rejected with 401: a server restart
 *  empties the session map while the tab still holds the old cookie. Only the
 *  cookie path can recover this way; a token 401 is surfaced unchanged. */
const withReconnect = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && getHumanToken() === null && !isDisconnected()) {
      await connectBrowser().catch(() => null);
      return fn();
    }
    throw err;
  }
};

export const sendMessage = async (
  to: string[] | 'all',
  message: string,
  from: 'human' | 'boss' = 'boss',
  messageId?: string,
): Promise<{ sent: string[]; skipped: string[] }> =>
  withReconnect(() =>
    requestJson<{ sent: string[]; skipped: string[] }>('/send', {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ to, message, from, ...(messageId === undefined ? {} : { messageId }) }),
    }),
  );

// Webchat: prompt the boss (like typing in the desktop session).
export const promptBoss = async (message: string): Promise<{ status: string }> =>
  withReconnect(() =>
    requestJson<{ status: string }>('/prompt', {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ message }),
    }),
  );

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

// Composer target resolution (legacy Composer.tsx submit rule): the Boss view
// composes through /prompt (webchat → boss); every other view direct-sends a
// `Human:` message to the picked agents via /send — an empty picker in the
// All view broadcasts to all agents ('all').
export type ComposeAction = { kind: 'prompt' } | { kind: 'send'; to: string[] | 'all' };

export const composeTarget = (view: View, picked: ReadonlySet<string>): ComposeAction =>
  view.kind === 'boss'
    ? { kind: 'prompt' }
    : { kind: 'send', to: picked.size ? [...picked] : 'all' };

export const projectGroups = (agents: Agent[]): Record<string, Agent[]> => {
  const groups: Record<string, Agent[]> = {};
  agents.forEach((a) => (groups[a.project] = (groups[a.project] ?? []).concat(a)));
  return groups;
};

// Message-bubble presentation rule (legacy MessageBubble.tsx): alignment is
// fixed by sender identity — Human (you) floats right in every view; agents
// and the boss float left. Labels:
// - Directional with time (`from → to · HH:MM`, Human: `HH:MM · to ← human`)
//   whenever the message has a non-empty recipient — agent-directed traffic
//   carries direction in every view, and All-project traffic shows direction
//   when a recipient exists.
// - Boss↔human channel messages (no recipient / to: boss prompts) keep the
//   plain `Sender · time` label in the Boss view.
export type BubbleKind = 'boss' | 'human' | 'agent';

export interface BubbleMeta {
  kind: BubbleKind;
  right: boolean;
  meta: string;
}

export const bubbleMeta = (m: Message, directional: boolean): BubbleMeta => {
  const kind: BubbleKind = m.from === 'boss' ? 'boss' : m.from === 'human' ? 'human' : 'agent';
  const right = kind === 'human';
  const to = m.to || (m.from === 'boss' ? 'human' : 'boss');
  const agentDirected =
    kind === 'agent' || (!!m.to && m.to !== 'boss' && m.to !== 'human');
  const showDirection = agentDirected || (directional && !!m.to);
  const meta = showDirection
    ? right
      ? `${hh(m.time)} · ${to} ← human`
      : `${m.from} → ${to} · ${hh(m.time)}`
    : `${kind === 'boss' ? 'Boss' : 'Human'} · ${hh(m.time)}`;
  return { kind, right, meta };
};
