
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REGISTRY = './agents.json';
const TEMPLATE = './agents.example.json';
const LOCAL_CONTEXT_DIR = './.memory/boss';
const LOCAL_CONTEXT = path.join(LOCAL_CONTEXT_DIR, 'local-context.md');
const LOCAL_CONTEXT_EXAMPLE = path.join(LOCAL_CONTEXT_DIR, 'local-context.example.md');

const report = [];
const upgrade = [];   // upgrade-path guidance (existing installs)
let failed = false;
let existingInstall = false;

function check(name, ok, detail = '') {
  report.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed = true;
}

// 1. Prerequisites
const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node >= 24', nodeMajor >= 24, `found ${process.versions.node}`);

const oc = spawnSync('opencode', ['--version'], { encoding: 'utf8', shell: true });
const ocOk = oc.status === 0 && (oc.stdout || '').trim().length > 0;
check('opencode CLI on PATH', ocOk, ocOk ? (oc.stdout || '').trim().split(/\r?\n/)[0] : 'not found - install from https://opencode.ai');

// 2. agents.json from template (never overwrite)
try {
  await fs.access(REGISTRY);
  existingInstall = true;
  report.push(`OK   ${REGISTRY} exists, left untouched`);
} catch {
  await fs.copyFile(TEMPLATE, REGISTRY);
  report.push(`DONE created ${REGISTRY} from ${TEMPLATE} - fill in real session IDs`);
}

// 2b. Local boss memory from example (never overwrite)
try {
  await fs.access(LOCAL_CONTEXT);
  report.push(`OK   ${LOCAL_CONTEXT} exists, left untouched`);
} catch {
  await fs.mkdir(LOCAL_CONTEXT_DIR, { recursive: true });
  await fs.copyFile(LOCAL_CONTEXT_EXAMPLE, LOCAL_CONTEXT);
  report.push(`DONE created ${LOCAL_CONTEXT} from ${LOCAL_CONTEXT_EXAMPLE}`);
}

// 2c. Projects folder (machine-local, gitignored - holds the human's
// project workspaces, each with its own git repo)
try {
  await fs.access('./projects');
  report.push('OK   ./projects exists, left untouched');
} catch {
  await fs.mkdir('./projects', { recursive: true });
  report.push('DONE created ./projects (gitignored - place project workspaces here)');
}

// 3. Existing install - upgrade-path checks (READ-ONLY: this script never
// touches your agents.json, your database, or any runtime state; it only
// reports what the post-migration architecture needs)
if (existingInstall) {
  // 3a. Order of operations - the retired legacy bridge may still be running
  // (the pull deleted bridge.mjs but a running process survives it, holding
  // port 3005). Stop it BEFORE backing up or starting the new server.
  let port3005Busy = false;
  try {
    const net = await import('node:net');
    port3005Busy = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: 3005, timeout: 1500 });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
  } catch { /* probe failure = treat as free */ }
  upgrade.push(port3005Busy
    ? 'ACTION port 3005 is IN USE - likely the retired legacy bridge still running (node bridge.mjs). Stop it first: it survives the pull and would block the new server.'
    : 'OK   port 3005 is free - the new server can bind it');
  upgrade.push('ORDER 1) stop the legacy bridge if running  2) back up .data\\messages.db (+ any -wal/-shm sidecars)  3) npm install  4) npm run build -w web  5) start the new server (README "Running")');

  // 3b. Workspaces installed? (server deps hoisted to root node_modules)
  const depsInstalled = fsSync.existsSync('./node_modules/fastify') && fsSync.existsSync('./node_modules/next') && fsSync.existsSync('./node_modules/.package-lock.json');
  upgrade.push(depsInstalled
    ? 'OK   npm workspaces installed (server/ + web/ deps present)'
    : 'TODO npm install   - required: the new architecture needs the server/ and web/ workspaces (a stale pre-migration node_modules is replaced by this)');

  // 3c. Dashboard built?
  upgrade.push(fsSync.existsSync('./web/out/index.html')
    ? 'OK   dashboard built (web/out/index.html present)'
    : 'TODO npm run build -w web   - without it the dashboard at /ui returns 404');

  // 3d. Message store - backup reminder (migrations apply automatically at
  // first server start; the backup is for peace of mind, not a requirement -
  // and only safe to take once the legacy bridge has STOPPED writing)
  upgrade.push(fsSync.existsSync('./.data/messages.db')
    ? 'NOTE .data/messages.db found - schema migrations apply automatically at the first server start (additive, existing rows untouched). Take a backup copy AFTER stopping the legacy bridge (a copy taken while it runs can miss WAL-buffered rows).'
    : 'NOTE no .data/messages.db yet - the store is created on first start');

  // 3e. Legacy leftovers that survive the pull (gitignored)
  if (fsSync.existsSync('./dist')) {
    upgrade.push('NOTE ./dist exists - legacy Vite build output, gitignored, unused by the new stack. Safe to delete.');
  }

  // 3f. Registry shape - read-only sanity report (never modified)
  try {
    const reg = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
    const count = Array.isArray(reg.agents) ? reg.agents.length : 0;
    upgrade.push(`OK   agents.json parses - ${count} agent entr${count === 1 ? 'y' : 'ies'} registered (your config is never modified by setup)`);
  } catch {
    upgrade.push(`WARN ${REGISTRY} is not valid JSON - check it manually; setup never edits your registry file`);
  }
}

// 4. Verify local OpenCode service
const svc = spawnSync('opencode', ['service', 'status'], { encoding: 'utf8', shell: true });
const url = (svc.stdout || '').trim().split(/\r?\n/)[0];
if (svc.status === 0 && /^https?:\/\//.test(url)) {
  report.push(`OK   OpenCode service reachable at ${url}`);
} else {
  report.push('WARN OpenCode service not reachable (the server needs it running)');
}

console.log('\n=== Agents-Lobby setup ===');
for (const line of report) console.log(line);

if (existingInstall && upgrade.length) {
  console.log('\n--- Install checks (existing agents.json - upgrade guidance) ---');
  for (const line of upgrade) console.log(line);
}

console.log(`
Next steps:
${existingInstall
    ? `  1. Apply any TODO lines above (npm install / npm run build -w web).
  2. Start the server (see README "Running"):  npx tsx server/src/server.ts`
    : `  1. Edit agents.json: replace the template session IDs with real ones
     (name, project, session - see agents.example.json for the shape).
  2. Start the server (see README "Running"):  npx tsx server/src/server.ts`}
Protocol details: README.md, section "For project-head agents".`);
process.exit(failed ? 1 : 0);

