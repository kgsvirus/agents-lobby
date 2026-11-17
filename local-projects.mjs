// local-projects.mjs — directory listing for /api/local-projects.
// Import side effects: NONE (pure module; fs is only read when
// listLocalProjects is called).
import fs from "node:fs/promises";

// ENOENT (projects folder not created yet) is not an error → empty list;
// anything else is rethrown so the route can answer a controlled 500
// instead of leaving an unhandled rejection to crash the bridge.
export async function listLocalProjects(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
}
