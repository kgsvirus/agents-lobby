// Chat infrastructure - peer-to-peer allowlist policy
// (`config/peer-to-peer-allowlist.json`).
//
// Non-secret policy, read fresh on every send like agents.json: the real file
// is machine-local (it names this machine's registered agents) and gitignored;
// the committed example is the shape. An ABSENT file means no peer may send
// (fail closed); a PRESENT-but-malformed file fails the request loudly rather
// than silently opening or closing every pair.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AppError } from '../../../shared/errors/index.js';
import type { PeerAllowlist } from '../domain/allowlist.js';
import { isPairAllowed } from '../domain/allowlist.js';

export { isPairAllowed };

const allowlistSchema = z.record(z.string().min(1), z.array(z.string().min(1)));

export const DEFAULT_ALLOWLIST_PATH = 'config/peer-to-peer-allowlist.json';

export async function readPeerAllowlist(filePath: string = DEFAULT_ALLOWLIST_PATH): Promise<PeerAllowlist> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new AppError(500, 'allowlist_invalid', `Cannot read peer allowlist ${filePath}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError(500, 'allowlist_invalid', `Peer allowlist ${filePath} is not valid JSON`);
  }
  const parsed = allowlistSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError(
      500,
      'allowlist_invalid',
      `Peer allowlist ${filePath} must map sender names to arrays of recipient names`,
    );
  }
  return parsed.data;
}
