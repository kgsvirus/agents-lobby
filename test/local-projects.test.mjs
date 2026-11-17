import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// Imports the leaf module only: zero import side effects (no agents.json
// read, no process.exit, no store, no server bind).
import { listLocalProjects } from '../local-projects.mjs';

const dirs = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lobby-projects-'));
  dirs.push(d);
  return d;
};

after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('listLocalProjects: existing dir returns subdirs, dot-entries and files excluded', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'TaskFlow'));
  fs.mkdirSync(path.join(dir, '.superpowers'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  assert.deepEqual(await listLocalProjects(dir), ['TaskFlow']);
});

test('listLocalProjects: missing dir resolves to [] instead of throwing', async () => {
  const missing = path.join(tmpDir(), 'does-not-exist');
  assert.deepEqual(await listLocalProjects(missing), []);
});
