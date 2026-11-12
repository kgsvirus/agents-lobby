import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CONFIG_FILE = './agents.json';
const MESSAGE_FILE = './incoming_messages.txt';
const WEBHOOK_PORT = 3005;

let config;
try {
  config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
} catch (err) {
  console.error(`[Bridge] Cannot read ${CONFIG_FILE}: ${err.message}`);
  process.exit(1);
}

// The local OpenCode server port changes on restart, so discover it at startup.
function discoverServerUrl() {
  try {
    const out = spawnSync('opencode', ['service', 'status'], { encoding: 'utf8', shell: true });
    const url = (out.stdout || '').trim().split(/\r?\n/)[0];
    if (/^https?:\/\//.test(url)) return url;
  } catch {}
  return config.serverUrl || null;
}

const SERVER_URL = discoverServerUrl();
console.log(`[Bridge] OpenCode server: ${SERVER_URL || '(not found)'}`);

// Registry is re-read per request so agents added to agents.json are usable
// without a bridge restart.
async function loadRegistry() {
  return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
}

// Local service credentials: HTTP Basic with the password from the service
// registration file (never stored in this repo).
const SERVICE_FILE = path.join(os.homedir(), '.config', 'opencode', 'service.json');

async function authHeader() {
  try {
    const reg = JSON.parse(await fs.readFile(SERVICE_FILE, 'utf8'));
    if (reg.password) return 'Basic ' + Buffer.from(`opencode:${reg.password}`).toString('base64');
  } catch {}
  return null;
}

async function api(pathname, init = {}) {
  const authorization = await authHeader();
  const res = await fetch(`${SERVER_URL}${pathname}`, {
    ...init,
    headers: { ...(authorization ? { authorization } : {}), ...init.headers },
  });
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function prompt(sessionID, text, delivery = 'queue') {
  return api(`/api/session/${sessionID}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, delivery }),
  });
}

const WAKE_PROMPT = `New messages were appended to ${MESSAGE_FILE}. Read the latest lines at the bottom of the file and respond.`;

// Token-free coalescing: a plain HTTP inbox check decides whether a wake is
// already pending; one pending wake reads all accumulated lines in one go.
async function wakeBoss() {
  if (!SERVER_URL) return console.error('[Bridge] No OpenCode server URL; cannot wake boss.');
  try {
    const { data } = await api(`/api/session/${config.boss.session}/inbox`);
    if (data.some((item) => item.type === 'user')) {
      console.log('[Bridge] Boss wake already pending, skipping.');
      return;
    }
    await prompt(config.boss.session, WAKE_PROMPT);
    console.log('[Bridge] Boss wake prompt enqueued.');
  } catch (err) {
    console.error('[Bridge] Wake failed:', err.message);
  }
}

async function appendMessage(entry) {
  // Guarantee exactly one newline between entries, whatever the previous writer did.
  let tail = '';
  try {
    const stat = await fs.stat(MESSAGE_FILE);
    if (stat.size > 0) {
      const fh = await fs.open(MESSAGE_FILE, 'r');
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, stat.size - 1);
      await fh.close();
      tail = buf.toString('utf8');
    }
  } catch {} // file missing → fresh start
  const prefix = tail && tail !== '\n' ? '\n' : '';
  await fs.appendFile(MESSAGE_FILE, prefix + entry, 'utf8');
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { from, message } = JSON.parse(body);
      const text = (message || '').trim();
      if (!text) return json(400, { error: 'message is required' });
      const tag = from ? ` [from: ${from}]` : '';
      await appendMessage(`[${new Date().toISOString()}]${tag} ${text}\n`);
      console.log(`[Webhook] Saved message${tag}: "${text}"`);
      wakeBoss();
      json(200, { status: 'ok' });
    } catch {
      json(400, { error: 'Invalid JSON' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/send') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { to, message } = JSON.parse(body);
      const text = (message || '').trim();
      if (!text) return json(400, { error: 'message is required' });
      if (!SERVER_URL) return json(500, { error: 'OpenCode server URL not discovered' });
      const config = await loadRegistry();
      const targets = to === 'all' ? config.agents : config.agents.filter((a) =>
        to === a.name || (Array.isArray(to) && to.includes(a.name)));
      if (!targets.length) return json(404, { error: `no matching agents for: ${JSON.stringify(to)}` });
      const results = await Promise.allSettled(targets.map((a) => prompt(a.session, `Boss: ${text}`)));
      const sent = [];
      const skipped = [];
      results.forEach((r, i) => (r.status === 'fulfilled' ? sent : skipped).push(targets[i].name));
      if (skipped.length) console.error(`[Send] Failed for: ${skipped.join(', ')}`);
      console.log(`[Send] Boss message sent to: ${sent.join(', ') || '(none)'}`);
      json(200, { sent, skipped });
    } catch {
      json(400, { error: 'Invalid JSON' });
    }
    return;
  }

  json(404, { error: 'not found' });
});

server.listen(WEBHOOK_PORT, () => {
  console.log(`[Bridge] Listening on http://localhost:${WEBHOOK_PORT}/webhook and /send`);
});
