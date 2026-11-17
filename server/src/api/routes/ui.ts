// Static serving of the web/ Next.js export at /ui (decision 2 — URL parity
// with the bridge at cutover: the bridge serves dist/ at /ui, bridge.mjs
// 220-253). Byte-parity with the bridge's handler:
//   - /ui            → index.html; /ui/<rel> → the file under the export dir
//   - `..` stripped from the requested path
//   - content types: html/js/css/svg/ico (+ the export's extra asset types),
//     anything else → application/octet-stream
//   - cache: .html → no-cache (a new deploy must never serve stale HTML that
//     references old pruned asset hashes); hashed assets → immutable for a
//     year (bridge: "assets/" prefix; the Next export's hashed assets live
//     under "_next/static/"); anything else → no cache header
//   - any failure (missing file/dir) → bare 404, like the bridge's catch
// The export dir defaults to ../web/out (resolved from the server package
// root, like migrationsFolder) and is overridable via LOBBY_UI_DIR.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Default export dir: web/out next to the server package (resolved from the
 * package root so the same code works from src or the tsc build).
 */
export function defaultUiRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Package root not found (no package.json above the ui route)');
    dir = parent;
  }
  return join(dir, '..', 'web', 'out');
}

const cacheControlFor = (rel: string): string | undefined => {
  if (extname(rel) === '.html') return 'no-cache';
  if (rel.startsWith('assets/') || rel.startsWith('_next/static/'))
    return 'public, max-age=31536000, immutable';
  return undefined;
};

export interface UiRoutesOptions {
  /** Root dir of the static export. Default: defaultUiRoot(). */
  readonly rootDir?: string;
}

export function uiRoutes(app: FastifyInstance, opts: UiRoutesOptions = {}): void {
  const root = opts.rootDir ?? defaultUiRoot();

  const serve = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const wildcard = (request.params as { '*': string })['*'];
    const rel = wildcard === undefined || wildcard === '' ? 'index.html' : wildcard;
    // Bridge-faithful: strip any dot-dots; the extension decides the type.
    const safeRel = rel.replace(/\.\./g, '');
    try {
      const data = await readFile(join(root, safeRel));
      const headers: Record<string, string> = {
        'Content-Type': CONTENT_TYPES[extname(safeRel)] ?? 'application/octet-stream',
      };
      const cacheControl = cacheControlFor(safeRel);
      if (cacheControl) headers['Cache-Control'] = cacheControl;
      return reply.status(200).headers(headers).send(data);
    } catch {
      return reply.status(404).send();
    }
  };
  app.get('/ui', serve);
  app.get('/ui/*', serve);
}
