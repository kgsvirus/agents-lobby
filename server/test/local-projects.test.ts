// GET /api/local-projects — decision-2 compatibility route (Task-1 ledger
// ruling). Expectations mirror the root test/local-projects.test.mjs fixtures
// against the bridge's route semantics (bridge.mjs:328-339): 200 + subdirs
// only (dot-entries and files excluded), missing dir → [] (ENOENT is not an
// error), any other readdir failure → 500 with the bridge's exact message
// inside the shared envelope (standing ruling). Query strings are ALLOWED —
// the bridge matches the URL pathname only.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { makeConfig, tempDir } from './helpers.js';
import { fakeOpenCode } from './chat-fakes.js';

function setup(opts: { projectsDir?: string } = {}) {
  const dir = tempDir();
  const projectsDir = opts.projectsDir ?? join(dir, 'projects');
  const env: Record<string, string> = { LOBBY_PROJECTS_DIR: projectsDir };
  const app = buildApp(makeConfig(dir, env), { opencode: fakeOpenCode().integration });
  return { app, dir, projectsDir };
}

describe('GET /api/local-projects', () => {
  it('lists subdirectories only — dot-entries and files excluded (root-test fixture)', async () => {
    const { app, projectsDir } = setup();
    try {
      mkdirSync(join(projectsDir, 'TaskFlow'), { recursive: true });
      mkdirSync(join(projectsDir, '.superpowers'));
      writeFileSync(join(projectsDir, 'notes.txt'), 'x');
      const res = await app.inject({ method: 'GET', url: '/api/local-projects' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(['TaskFlow']);
    } finally {
      await app.close();
    }
  });

  it('missing dir resolves to [] instead of failing (bridge ENOENT rule)', async () => {
    // The default projectsDir path is never created in this test — ENOENT.
    const { app } = setup();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/local-projects' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a failed readdir answers 500 with the bridge-identical message in the envelope', async () => {
    // Readdir failure mode: the projects path is a FILE (ENOTDIR).
    const { app, dir } = setup();
    const filePath = join(dir, 'projects');
    writeFileSync(filePath, 'not a directory');
    const expectedMessage = await fsp
      .readdir(filePath, { withFileTypes: true })
      .then(() => null)
      .catch((err: Error) => err.message);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/local-projects' });
      expect(res.statusCode).toBe(500);
      const body = res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('local_projects_failed');
      expect(body.error.message).toBe(expectedMessage); // bridge json(500, {error: err.message})
    } finally {
      await app.close();
    }
  });

  it('query strings are allowed (bridge matches the URL pathname)', async () => {
    const { app } = setup();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/local-projects?x=1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
