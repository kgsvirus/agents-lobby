import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SECTION_FILE = './.placeholder/agents-md-section.md';
// Match any heading variant: "## Agent Lobby", "## 8.1 Agent Lobby", "### 9. Agent Lobby", etc.
const SECTION_PATTERN = /^#{1,6} [\d.]*\s*Agent Lobby\b/m;
const GLOBAL_AGENTS_MD = path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
const REGISTRY = './agents.json';
const TEMPLATE = './agents.example.json';

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

// 3. Global AGENTS.md: install section 8.1 idempotently
const section = await fs.readFile(SECTION_FILE, 'utf8');
let agentsMd;
try {
  agentsMd = await fs.readFile(GLOBAL_AGENTS_MD, 'utf8');
} catch {
  agentsMd = null;
}
if (agentsMd === null) {
  await fs.mkdir(path.dirname(GLOBAL_AGENTS_MD), { recursive: true });
  await fs.writeFile(GLOBAL_AGENTS_MD, section, 'utf8');
  report.push(`DONE created ${GLOBAL_AGENTS_MD} with the Agent Lobby section`);
} else if (SECTION_PATTERN.test(agentsMd)) {
  report.push(`OK   Agent Lobby section already in global AGENTS.md, skipped`);
} else {
  const sep = agentsMd.endsWith('\n') ? '\n' : '\n\n';
  await fs.appendFile(GLOBAL_AGENTS_MD, sep + section, 'utf8');
  report.push(`DONE appended Agent Lobby section to ${GLOBAL_AGENTS_MD}`);
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
