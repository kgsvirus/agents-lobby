#!/usr/bin/env node
// Mints peer-messaging principal tokens into .data/peer-auth.json.
//
//   node gen-peer-tokens.mjs            # rotate every identity (human, boss, agents)
//   node gen-peer-tokens.mjs ruben      # rotate just that identity
//   node gen-peer-tokens.mjs --prune    # also drop identities no longer registered
//
// The file is gitignored and is the only place tokens live. Tokens are printed
// once, when minted: after that only the agent using one needs it.
//
// setup.mjs deliberately does not call this: a token a setup run produces is
// still a secret, and rotating every credential on upgrade would break agents
// that already hold one.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_AGENTS = resolve('config/agents.json');
const DEFAULT_AUTH = resolve('.data/peer-auth.json');

const mint = () => randomBytes(32).toString('base64url');

/** Principals that always exist, regardless of the registry. */
const FIXED = [
  { name: 'human', kind: 'human' },
  { name: 'boss', kind: 'boss' },
];

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    // Tolerate a UTF-8 BOM: Windows editors add one, JSON.parse does not.
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`);
  }
}

/**
 * Rotates tokens for one principal (target) or all of them.
 * Returns the minted entries; the file already holds them.
 */
export function generate({
  agentsPath = DEFAULT_AGENTS,
  authPath = DEFAULT_AUTH,
  target = null,
  prune = false,
} = {}) {
  const registry = readJson(agentsPath, { agents: [] });
  const agents = Array.isArray(registry.agents) ? registry.agents : [];
  const principals = [
    ...FIXED,
    ...agents.map((a) => ({ name: a.name, kind: 'agent' })),
  ];

  if (target !== null) {
    const known = principals.find((p) => p.name === target);
    if (!known) {
      throw new Error(
        `unknown identity "${target}" - expected one of: ${principals.map((p) => p.name).join(', ')}`,
      );
    }
  }

  const auth = readJson(authPath, { tokens: {} });
  const previous = auth.tokens ?? {};
  const kept = Object.entries(previous).filter(([, value]) => {
    if (!prune) return true;
    return principals.some((p) => p.name === value.name);
  });

  const next = {};
  const minted = [];
  // Rebuild: drop the rotated names first so an identity never has two tokens.
  for (const [token, value] of kept) {
    const rotating = target === null || value.name === target;
    if (rotating) continue;
    next[token] = value;
  }

  const toMint = target === null ? principals : principals.filter((p) => p.name === target);
  for (const principal of toMint) {
    const token = mint();
    next[token] = { name: principal.name, kind: principal.kind };
    minted.push({ ...principal, token });
  }

  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, `${JSON.stringify({ tokens: next }, null, 2)}\n`, 'utf8');

  const dropped = Object.keys(previous).length - kept.length;
  return { minted, path: authPath, dropped, total: Object.keys(next).length };
}

function main(argv) {
  const args = argv.slice(2);
  const prune = args.includes('--prune');
  const names = args.filter((a) => !a.startsWith('--'));

  if (names.length > 1) {
    console.error('usage: node gen-peer-tokens.mjs [name] [--prune]');
    process.exit(2);
  }

  try {
    const result = generate({ target: names[0] ?? null, prune });
    console.log(`Minted ${result.minted.length} token(s) -> ${result.path}`);
    if (result.dropped > 0) console.log(`Dropped ${result.dropped} token(s) for unregistered identities`);
    console.log('');
    const width = Math.max(...result.minted.map((m) => m.name.length), 4);
    const kindWidth = Math.max(...result.minted.map((m) => m.kind.length), 4);
    for (const m of result.minted) {
      console.log(`${m.name.padEnd(width)}  ${m.kind.padEnd(kindWidth)}  ${m.token}`);
    }
    console.log('');
    console.log('These tokens are shown once. The file is gitignored; nothing else stores them.');
    if (result.total > result.minted.length) {
      console.log(
        `${result.total - result.minted.length} other identity token(s) kept unchanged.`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main(process.argv);
