// Registry role field: an agent's role is a registry property (machine-local),
// not a policy-file property. Absent role = the agent is inert for peer
// messaging (fail closed); it never changes how the agent is listed.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonRegistryReader } from '../src/infrastructure/registry/reader.js';
import { tempDir } from './helpers.js';

function registryFile(content: unknown): string {
  const file = join(tempDir(), 'agents.json');
  writeFileSync(file, JSON.stringify(content), 'utf8');
  return file;
}

describe('registry roles', () => {
  it('reads an optional role per agent and keeps entries without one', async () => {
    const reader = new JsonRegistryReader(
      registryFile({
        boss: { name: 'boss', project: 'Agents-Lobby', session: 'ses_boss' },
        agents: [
          { name: 'ruben', project: 'TaskFlow', session: 'ses_r', role: 'coordinator' },
          { name: 'marvin', project: 'ImmigApp', session: 'ses_m' },
        ],
      }),
    );
    const snapshot = await reader.read();
    expect(snapshot.agents.map((a) => [a.name, a.role])).toEqual([
      ['ruben', 'coordinator'],
      ['marvin', undefined],
    ]);
  });

  it('rejects an empty role rather than treating it as absent', async () => {
    const reader = new JsonRegistryReader(
      registryFile({ agents: [{ name: 'x', project: 'p', session: 'ses_x', role: '' }] }),
    );
    await expect(reader.read()).rejects.toMatchObject({ statusCode: 500 });
  });

  it('absent registry = empty snapshot with no agents', async () => {
    const reader = new JsonRegistryReader(join(tempDir(), 'missing.json'));
    await expect(reader.read()).resolves.toEqual({ serverUrl: null, boss: null, agents: [] });
  });
});
