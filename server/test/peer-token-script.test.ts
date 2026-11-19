// gen-peer-tokens.mjs: rotation semantics and the file it owns.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from '../../gen-peer-tokens.mjs';

const dirs: string[] = [];

function fixture(agents: { name: string }[], tokens: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'peer-tokens-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'agents.json'), JSON.stringify({ agents }));
  const authPath = join(dir, '.data', 'peer-auth.json');
  if (Object.keys(tokens).length > 0) {
    mkdirSync(join(dir, '.data'), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ tokens }));
  }
  return {
    agentsPath: join(dir, 'config', 'agents.json'),
    authPath,
    read: () => JSON.parse(readFileSync(authPath, 'utf8')).tokens as Record<
      string,
      { name: string; kind: string }
    >,
  };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('gen-peer-tokens', () => {
  it('mints human, boss and every registered agent on a bare run', () => {
    const f = fixture([{ name: 'ruben' }, { name: 'greg' }]);
    const result = generate({ agentsPath: f.agentsPath, authPath: f.authPath });

    expect(result.minted.map((m) => m.name).sort()).toEqual(['boss', 'greg', 'human', 'ruben']);
    const tokens = f.read();
    expect(Object.keys(tokens)).toHaveLength(4);
    expect(tokens[result.minted[0].token].kind).toBe(result.minted[0].kind);
    // 32 random bytes, base64url
    for (const entry of Object.values(tokens)) expect(entry.name).toBeTruthy();
    for (const key of Object.keys(tokens)) expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rotates one identity and leaves the others byte-identical', () => {
    const f = fixture([{ name: 'ruben' }, { name: 'greg' }]);
    generate({ agentsPath: f.agentsPath, authPath: f.authPath });
    const before = f.read();

    const result = generate({ agentsPath: f.agentsPath, authPath: f.authPath, target: 'ruben' });
    expect(result.minted).toHaveLength(1);
    expect(result.minted[0].name).toBe('ruben');

    const after = f.read();
    const gregBefore = Object.entries(before).find(([, v]) => v.name === 'greg')!;
    const gregAfter = Object.entries(after).find(([, v]) => v.name === 'greg')!;
    expect(gregAfter[0]).toBe(gregBefore[0]); // same token
    expect(Object.values(after).filter((v) => v.name === 'ruben')).toHaveLength(1);
    expect(Object.keys(after)).toHaveLength(Object.keys(before).length);
  });

  it('rejects an unknown identity without touching the file', () => {
    const f = fixture([{ name: 'ruben' }]);
    generate({ agentsPath: f.agentsPath, authPath: f.authPath });
    const before = f.read();

    expect(() =>
      generate({ agentsPath: f.agentsPath, authPath: f.authPath, target: 'nobody' }),
    ).toThrow(/unknown identity/);
    expect(f.read()).toEqual(before);
  });

  it('keeps tokens for unregistered names unless --prune is asked for', () => {
    const f = fixture(
      [{ name: 'ruben' }],
      {
        stale: { name: 'gone', kind: 'agent' },
        human: { name: 'human', kind: 'human' },
      },
    );
    generate({ agentsPath: f.agentsPath, authPath: f.authPath, target: 'ruben' });
    expect(Object.values(f.read()).some((v) => v.name === 'gone')).toBe(true);

    const pruned = generate({ agentsPath: f.agentsPath, authPath: f.authPath, prune: true });
    expect(pruned.dropped).toBe(1);
    expect(Object.values(f.read()).some((v) => v.name === 'gone')).toBe(false);
  });

  it('creates the data directory and the file when neither exists', () => {
    const f = fixture([{ name: 'ruben' }]);
    generate({ agentsPath: f.agentsPath, authPath: f.authPath });
    expect(Object.keys(f.read())).toHaveLength(3);
  });
});
