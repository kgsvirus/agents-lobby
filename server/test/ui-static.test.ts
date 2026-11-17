// /ui static serving (decision 2): bridge cache semantics ported from
// bridge.mjs 220-253 — /ui → index.html, hashed assets immutable, HTML
// no-cache, dot-dot stripping, bare 404 on misses.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultUiRoot } from '../src/api/routes/ui.js';
import { makeConfig, tempDir } from './helpers.js';
import { fakeOpenCode } from './chat-fakes.js';

function setupWithExport(): { dir: string } {
  const dir = mkdtempSync(join(tempDir(), 'ui-export-'));
  mkdirSync(join(dir, '_next', 'static'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    // Mirrors the real export's ref style (basePath '/ui'): origin-rooted
    // /ui-prefixed asset URLs behind the Fastify /ui mount.
    '<!doctype html><html><head><link href="/ui/_next/static/css/HASH.css" rel="stylesheet"/><script src="/ui/_next/static/app-HASH.js"></script></head><body></body></html>',
  );
  writeFileSync(join(dir, '_next', 'static', 'app-HASH.js'), 'console.log("app")');
  mkdirSync(join(dir, '_next', 'static', 'css'), { recursive: true });
  writeFileSync(join(dir, '_next', 'static', 'css', 'HASH.css'), 'body{}');
  writeFileSync(join(dir, 'favicon.ico'), 'ico');
  const app = buildApp(makeConfig(dir, { LOBBY_UI_DIR: dir }), {
    opencode: fakeOpenCode().integration,
  });
  return { dir };
}

describe('GET /ui static export', () => {
  it('serves index.html at /ui with no-cache (stale HTML must not survive deploys)', async () => {
    const { dir } = setupWithExport();
    const app = buildApp(makeConfig(dir, { LOBBY_UI_DIR: dir }), {
      opencode: fakeOpenCode().integration,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/ui' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('_next/static/app-HASH.js');
    } finally {
      await app.close();
    }
  });

  it('serves hashed assets with the immutable year cache', async () => {
    const { dir } = setupWithExport();
    const app = buildApp(makeConfig(dir, { LOBBY_UI_DIR: dir }), {
      opencode: fakeOpenCode().integration,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/ui/_next/static/app-HASH.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/javascript');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    } finally {
      await app.close();
    }
  });

  it('strips dot-dots and 404s on misses with an empty body (bridge catch)', async () => {
    const { dir } = setupWithExport();
    const app = buildApp(makeConfig(dir, { LOBBY_UI_DIR: dir }), {
      opencode: fakeOpenCode().integration,
    });
    try {
      const traversal = await app.inject({ method: 'GET', url: '/ui/..%2F..%2Fpackage.json' });
      expect(traversal.statusCode).toBe(404);

      const missing = await app.inject({ method: 'GET', url: '/ui/nope.js' });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toBe('');
    } finally {
      await app.close();
    }
  });

  it('defaults the export root to ../web/out next to the server package', () => {
    expect(defaultUiRoot().replace(/\\/g, '/')).toMatch(/web\/out$/);
  });

  it('serves every asset referenced by the fixture export with a real content type', async () => {
    const { dir } = setupWithExport();
    const app = buildApp(makeConfig(dir, { LOBBY_UI_DIR: dir }), {
      opencode: fakeOpenCode().integration,
    });
    try {
      const html = (await app.inject({ method: 'GET', url: '/ui' })).body;
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
      expect(refs).toContain('/ui/_next/static/app-HASH.js');
      for (const ref of refs) {
        const res = await app.inject({ method: 'GET', url: ref });
        expect(res.statusCode, ref).toBe(200);
        expect(res.headers['content-type'], ref).not.toBe('application/octet-stream');
      }
    } finally {
      await app.close();
    }
  });

  // The REAL export check: parses the actual web/out/index.html (basePath
  // '/ui') and fetches every asset ref through the /ui route — the acceptance
  // guarantee that the built page loads with styles and behavior. The official
  // gate runs `npm run build -w web` BEFORE vitest; if the export is missing
  // the gate order was violated — FAIL LOUD (a silent skip would make the
  // gate lie).
  it('the real web/out export serves all its asset refs through /ui', async () => {
    const outDir = defaultUiRoot();
    const htmlPath = join(outDir, 'index.html');
    if (!existsSync(htmlPath)) {
      throw new Error(
        `web/out/index.html missing at ${htmlPath} — run \`npm run build -w web\` before vitest (official gate order); skipping this check would make the gate lie`,
      );
    }
    const html = readFileSync(htmlPath, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    // basePath '/ui' must have rewritten the refs; a root-absolute /_next/
    // ref would 404 behind the /ui mount.
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => r.startsWith('/_next/'))).toEqual([]);
    const dir = tempDir();
    const app = buildApp(
      makeConfig(dir, { LOBBY_UI_DIR: outDir }),
      { opencode: fakeOpenCode().integration },
    );
    try {
      const res = await app.inject({ method: 'GET', url: '/ui' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(html);
      for (const ref of refs) {
        const asset = await app.inject({ method: 'GET', url: ref });
        expect(asset.statusCode, ref).toBe(200);
        expect(asset.headers['content-type'], ref).not.toBe('application/octet-stream');
      }
    } finally {
      await app.close();
    }
  });
});
