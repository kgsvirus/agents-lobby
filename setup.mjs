import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REGISTRY = './agents.json';
const TEMPLATE = './agents.example.json';
const LOCAL_CONTEXT_DIR = './.memory/boss';
const LOCAL_CONTEXT = path.join(LOCAL_CONTEXT_DIR, 'local-context.md');
const LOCAL_CONTEXT_EXAMPLE = path.join(LOCAL_CONTEXT_DIR, 'local-context.example.md');

const report = [];
let failed = false;

function check(name, ok, detail = '') {
  report.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed = true;
}

// 1. Prerequisites
const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node >= 18', nodeMajor >= 18, `found ${process.versions.node}`);

const oc = spawnSync('opencode', ['--version'], { encoding: 'utf8', shell: true });
const ocOk = oc.status === 0 && (oc.stdout || '').trim().length > 0;
check('opencode CLI on PATH', ocOk, ocOk ? (oc.stdout || '').trim().split(/\r?\n/)[0] : 'not found - install from https://opencode.ai');

// 2. agents.json from template (never overwrite)
try {
  await fs.access(REGISTRY);
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

// 4. Verify local OpenCode service
const svc = spawnSync('opencode', ['service', 'status'], { encoding: 'utf8', shell: true });
const url = (svc.stdout || '').trim().split(/\r?\n/)[0];
if (svc.status === 0 && /^https?:\/\//.test(url)) {
  report.push(`OK   OpenCode service reachable at ${url}`);
} else {
  report.push('WARN OpenCode service not reachable (the bridge needs it running)');
}

console.log('\n=== Agents-Lobby setup ===');
for (const line of report) console.log(line);
console.log(`
Next steps:
  1. Edit agents.json: replace the template session IDs with real ones
     (name, project, session - see agents.example.json for the shape).
  2. Start the bridge:  node bridge.mjs
Protocol details: README.md, section "For project-head agents".`);
process.exit(failed ? 1 : 0);
