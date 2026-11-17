// Port of the bridge's local-projects.mjs (listLocalProjects, lines 1-20):
// directory listing of the machine-local projects/ workspace for
// /api/local-projects. Lobby domain (NOT OpenCode); infrastructure owns fs
// access per the layer rules. Import side effects: NONE.
import { readdir } from 'node:fs/promises';

export type LocalProjectsReader = (dir: string) => Promise<string[]>;

/**
 * ENOENT (projects folder not created yet — fresh clone) is not an error →
 * empty list; anything else is rethrown so the route can answer a controlled
 * 500 instead of an unhandled rejection (bridge.mjs:332-338).
 */
export const readLocalProjects: LocalProjectsReader = async (dir) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
};
