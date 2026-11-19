// Peer-to-peer allowlist policy - who may address whom, in ROLE terms.
//
// Non-secret, machine-local (gitignored): the reference roles are this
// machine's vocabulary. Shape is committed in
// `config/peer-to-peer-allowlist.example.json`; setup copies it on first run.
//
// Rules this file feeds:
//   - a sender ROLE may address only the roles listed under its own key
//   - no wildcard: `coordinator` already means every coordinator
//   - an agent's role comes from agents.json, never from the request
//   - peers cannot send to "all" or to a list of recipients
//   - Human: / Boss: prefixes are never produced by a peer, whatever this
//     file says
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPairAllowed, readPeerAllowlist } from '../src/modules/chat/infrastructure/peer-allowlist.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'lobby-allowlist-'));

function jsonFile(content: unknown): string {
  const file = join(dir(), 'allowlist.json');
  writeFileSync(file, JSON.stringify(content), 'utf8');
  return file;
}

describe('peer allowlist', () => {
  it('allows exactly the listed role pairs, nothing implied', async () => {
    const acl = await readPeerAllowlist(
      jsonFile({ human: ['boss', 'coordinator'], boss: ['human'], coordinator: ['human', 'boss'] }),
    );
    expect(isPairAllowed(acl, 'coordinator', 'boss')).toBe(true);
    expect(isPairAllowed(acl, 'coordinator', 'human')).toBe(true);
    expect(isPairAllowed(acl, 'coordinator', 'developer')).toBe(false);
    expect(isPairAllowed(acl, 'developer', 'coordinator')).toBe(false); // not symmetric
    expect(isPairAllowed(acl, 'unknown', 'boss')).toBe(false);
  });

  it('an absent file yields an empty allowlist: no peer may send', async () => {
    const acl = await readPeerAllowlist(join(dir(), 'missing.json'));
    expect(acl).toEqual({});
    expect(isPairAllowed(acl, 'coordinator', 'boss')).toBe(false);
  });

  it('accepts the role shape and rejects a non-array value', async () => {
    const acl = await readPeerAllowlist(jsonFile({ human: ['boss', 'coordinator'], boss: ['human'] }));
    expect(acl).toEqual({ human: ['boss', 'coordinator'], boss: ['human'] });
    await expect(readPeerAllowlist(jsonFile({ human: 'boss' }))).rejects.toMatchObject({
      code: 'allowlist_invalid',
    });
  });

  it('a malformed file fails loudly instead of opening or closing silently', async () => {
    const file = join(dir(), 'bad.json');
    writeFileSync(file, '{ "human": "boss" }', 'utf8');
    await expect(readPeerAllowlist(file)).rejects.toMatchObject({
      statusCode: 500,
      code: 'allowlist_invalid',
    });

    const broken = join(dir(), 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    await expect(readPeerAllowlist(broken)).rejects.toMatchObject({ code: 'allowlist_invalid' });
  });

  it('rejects a trailing comma (invalid JSON) rather than guessing', async () => {
    const file = join(dir(), 'trailing.json');
    writeFileSync(file, '{ "human": ["boss"], }', 'utf8');
    await expect(readPeerAllowlist(file)).rejects.toMatchObject({ code: 'allowlist_invalid' });
  });
});
