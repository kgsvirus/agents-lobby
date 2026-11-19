
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REGISTRY = './config/agents.json';
const TEMPLATE = './config/agents.example.json';
const PEER_ALLOWLIST = './config/peer-to-peer-allowlist.json';
const PEER_ALLOWLIST_EXAMPLE = './config/peer-to-peer-allowlist.example.json';
const PEER_AUTH = './.data/peer-auth.json';
const LOCAL_CONTEXT_DIR = './.memory/boss';
const LOCAL_CONTEXT = path.join(LOCAL_CONTEXT_DIR, 'local-context.md');
const LOCAL_CONTEXT_EXAMPLE = path.join(LOCAL_CONTEXT_DIR, 'local-context.example.md');

const FIX = process.argv.includes('--fix');

const report = [];
let failed = false;
let existingInstall = false;

function check(name, ok, detail = '') {
  report.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed = true;
}

// Is something listening on the production port? (shared by plain-mode
// checks and the --fix pre-flight so the two cannot drift)
function probe3005() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 3005, timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

// 1. Prerequisites
const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node >= 24', nodeMajor >= 24, `found ${process.versions.node}`);

const oc = spawnSync('opencode', ['--version'], { encoding: 'utf8', shell: true });
const ocOk = oc.status === 0 && (oc.stdout || '').trim().length > 0;
check('opencode CLI on PATH', ocOk, ocOk ? (oc.stdout || '').trim().split(/\r?\n/)[0] : 'not found - install from https://opencode.ai');

// 2. config/agents.json from template (never overwrite)
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

// 2d. Peer-to-peer allowlist from the committed example (never overwrite;
// non-secret policy, but the names are this machine's agents -> gitignored)
try {
  await fs.access(PEER_ALLOWLIST);
  report.push(`OK   ${PEER_ALLOWLIST} exists, left untouched`);
} catch {
  await fs.mkdir(path.dirname(PEER_ALLOWLIST), { recursive: true });
  await fs.copyFile(PEER_ALLOWLIST_EXAMPLE, PEER_ALLOWLIST);
  report.push(`DONE created ${PEER_ALLOWLIST} from ${PEER_ALLOWLIST_EXAMPLE} - edit the role -> roles policy`);
}

// 2e. Principal tokens for peer messaging: NEVER generated here (a token the
// operator did not choose is a secret in a log line waiting to happen).
if (fsSync.existsSync(PEER_AUTH)) {
  report.push(`OK   ${PEER_AUTH} exists (principal tokens, gitignored)`);
} else {
  report.push(`NOTE no ${PEER_AUTH} - peer sends stay closed until you create it: {"tokens": {"<token>": {"name": "ruben", "kind": "agent"}}}`);
}

// 3. Install checks (existing installs) - READ-ONLY: this script never
// touches your config/agents.json, your database, or any runtime state; it only
// reports what the post-migration architecture needs. Shared by plain mode
// and --fix (identical lines, single source).
async function runChecks() {
  const lines = [];
  // Order of operations - the retired legacy bridge may still be running
  // (the pull deleted bridge.mjs but a running process survives it, holding
  // port 3005). Stop it BEFORE backing up or starting the new server.
  if (await probe3005()) {
    lines.push('ACTION port 3005 is IN USE - likely the retired legacy bridge still running (node bridge.mjs). Stop it first: it survives the pull and would block the new server.');
  } else {
    lines.push('OK   port 3005 is free - the new server can bind it');
  }
  lines.push('ORDER 1) stop the legacy bridge if running  2) back up .data\\messages.db (+ any -wal/-shm sidecars)  3) npm install  4) npm run build -w web  5) start the new server (README "Running")');

  // Workspaces installed? (server deps hoisted to root node_modules)
  const depsInstalled = fsSync.existsSync('./node_modules/fastify') && fsSync.existsSync('./node_modules/next') && fsSync.existsSync('./node_modules/.package-lock.json');
  lines.push(depsInstalled
    ? 'OK   npm workspaces installed (server/ + web/ deps present)'
    : 'TODO npm install   - required: the new architecture needs the server/ and web/ workspaces (a stale pre-migration node_modules is replaced by this)');

  // Dashboard built?
  lines.push(fsSync.existsSync('./web/out/index.html')
    ? 'OK   dashboard built (web/out/index.html present)'
    : 'TODO npm run build -w web   - without it the dashboard at /ui returns 404');

  // Message store - backup reminder (migrations apply automatically at
  // first server start; the backup is for peace of mind, not a requirement -
  // and only safe to take once the legacy bridge has STOPPED writing)
  lines.push(fsSync.existsSync('./.data/messages.db')
    ? 'NOTE .data/messages.db found - schema migrations apply automatically at the first server start (additive, existing rows untouched). Take a backup copy AFTER stopping the legacy bridge (a copy taken while it runs can miss WAL-buffered rows).'
    : 'NOTE no .data/messages.db yet - the store is created on first start');

  // Legacy leftovers that survive the pull (gitignored)
  if (fsSync.existsSync('./dist')) {
    lines.push('NOTE ./dist exists - legacy Vite build output, gitignored, unused by the new stack. Safe to delete.');
  }

  // Registry shape - read-only sanity report (never modified)
  try {
    const reg = JSON.parse(await fs.readFile(REGISTRY, 'utf8'));
    const count = Array.isArray(reg.agents) ? reg.agents.length : 0;
    lines.push(`OK   config/agents.json parses - ${count} agent entr${count === 1 ? 'y' : 'ies'} registered (your config is never modified by setup)`);
  } catch {
    lines.push(`WARN ${REGISTRY} is not valid JSON - check it manually; setup never edits your registry file`);
  }
  return lines;
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

if (FIX) {
  // --fix: the ORDER line, executed for its safe steps. Stopping a process
  // and starting the long-lived server stay human (kill-unknown-owner and
  // keep-alive-forever are not script jobs).
  if (failed) {
    console.log('FAIL prerequisites not met - fix the FAIL lines above before running --fix');
    process.exit(1);
  }
  if (await probe3005()) {
    console.log('ACTION port 3005 is IN USE - stop the process holding it, then re-run: node setup.mjs --fix');
    process.exit(0);
  }

  // Backup (sidecar-safe, cutover-runbook pattern): copy main + sidecars
  // RENAMED to the backup base, fold the WAL into the copy, verify, drop
  // the sidecar copies. "Alongside" copying would silently lose WAL rows.
  if (fsSync.existsSync('./.data/messages.db')) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS, colon-free, no trailing dot
    const bak = `.data/messages.db.bak-${stamp}`;
    fsSync.copyFileSync('./.data/messages.db', bak);
    for (const s of ['-wal', '-shm']) {
      if (fsSync.existsSync(`./.data/messages.db${s}`)) fsSync.copyFileSync(`./.data/messages.db${s}`, bak + s);
    }
    const { DatabaseSync } = await import('node:sqlite');
    const c = new DatabaseSync(bak);
    c.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const row = c.prepare('PRAGMA integrity_check').get();
    c.close();
    for (const s of ['-wal', '-shm']) fsSync.rmSync(bak + s, { force: true });
    if (row.integrity_check !== 'ok') {
      console.log(`FAIL backup copy failed integrity check (${row.integrity_check}) - aborting before any install`);
      process.exit(1);
    }
    console.log(`DONE backup ${bak} (integrity: ok)`);
  } else {
    console.log('NOTE no .data/messages.db yet - nothing to back up');
  }

  const run = (args, what) => {
    const r = spawnSync('npm', args, { stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      console.log(`FAIL ${what} (exit code ${r.status ?? 1}) - fix the error above, then re-run: node setup.mjs --fix`);
      process.exit(1);
    }
  };
  run(['install'], 'npm install');
  run(['run', 'build', '-w', 'web'], 'npm run build -w web');

  console.log('\n--- Post-fix checks ---');
  for (const line of await runChecks()) console.log(line);

  // Final human step - fresh-clone-aware: a fresh clone must edit its
  // registry before starting (plain mode's guidance, not silently skipped).
  if (!existingInstall) {
    console.log('\nNext: edit config/agents.json - replace the template session IDs with real ones (see config/agents.example.json).');
  }
  console.log('Then start the server (README "Running"):');
  console.log("  $env:LOBBY_PORT='3005'; $env:LOBBY_DB_PATH='.data/messages.db'");
  console.log('  npx tsx server/src/server.ts');
  process.exit(0);
}

if (existingInstall) {
  const upgrade = await runChecks();
  if (upgrade.length) {
    console.log('\n--- Install checks (existing config/agents.json - upgrade guidance) ---');
    for (const line of upgrade) console.log(line);
  }
}

console.log(`
Next steps:
${existingInstall
    ? `  1. Apply any TODO lines above (npm install / npm run build -w web).
  2. Start the server (see README "Running"):  npx tsx server/src/server.ts`
    : `  1. Edit config/agents.json: replace the template session IDs with real ones
     (name, project, session - see config/agents.example.json for the shape).
  2. Start the server (see README "Running"):  npx tsx server/src/server.ts`}
Protocol details: README.md, section "For project-head agents".`);
process.exit(failed ? 1 : 0);
