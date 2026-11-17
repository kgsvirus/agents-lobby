// OpenCode adapter client tests: URL discovery/fallback, auth header,
// timeouts, error mapping. No live server — fetch/discovery/password are
// injected fakes (bridge.mjs:22-92 ports).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  createOpenCodeClient,
  defaultDiscoverServerUrl,
  OpenCodeRequestError,
  openCodeClientConfigSchema,
} from '../src/integrations/opencode/client.js';
import { createOpenCodeIntegration, PortError } from '../src/integrations/opencode/index.js';
import * as opencodeIndex from '../src/integrations/opencode/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createOpenCodeClient', () => {
  it('prefers a discovered http(s) URL over the configured fallback (bridge.mjs:22-34)', () => {
    const discovered = createOpenCodeClient(
      { fallbackServerUrl: 'http://fallback:1234' },
      { discover: () => 'http://localhost:4096' },
    );
    expect(discovered.serverUrl).toBe('http://localhost:4096');
  });

  it('falls back to the configured URL when discovery yields a non-URL', () => {
    const client = createOpenCodeClient(
      { fallbackServerUrl: 'http://fallback:1234' },
      { discover: () => 'not a url' },
    );
    expect(client.serverUrl).toBe('http://fallback:1234');
  });

  it('falls back when discovery returns null, and resolves to null with neither', () => {
    expect(
      createOpenCodeClient({ fallbackServerUrl: 'http://f:1' }, { discover: () => null }).serverUrl,
    ).toBe('http://f:1');
    expect(createOpenCodeClient({ fallbackServerUrl: null }, { discover: () => null }).serverUrl).toBeNull();
  });

  it('attaches Basic auth from the service password and no header when absent (bridge.mjs:64-84)', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ ok: true });
    });
    const withPw = createOpenCodeClient(
      { fallbackServerUrl: 'http://x' },
      { fetchImpl, readServicePassword: async () => 's3cret', discover: () => null },
    );
    await withPw.request('/api/session/ses_1/inbox');
    expect(seen[0]?.url).toBe('http://x/api/session/ses_1/inbox');
    const expected = 'Basic ' + Buffer.from('opencode:s3cret').toString('base64');
    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get('authorization')).toBe(expected);

    seen.length = 0;
    const openAccess = createOpenCodeClient(
      { fallbackServerUrl: 'http://x' },
      { fetchImpl, readServicePassword: async () => null, discover: () => null },
    );
    await openAccess.request('/api/session/ses_1/inbox');
    expect(new Headers(seen[0]?.init.headers).get('authorization')).toBeNull();
  });

  it('passes an abort signal (request timeout) to every upstream request (decision 4)', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return jsonResponse({});
    });
    const client = createOpenCodeClient(
      { fallbackServerUrl: 'http://x', timeoutMs: 1234 },
      { fetchImpl, discover: () => null },
    );
    await client.request('/api/session/ses_1/inbox');
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps HTTP failures to OpenCodeRequestError with status and body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const client = createOpenCodeClient(
      { fallbackServerUrl: 'http://x' },
      { fetchImpl, discover: () => null },
    );
    await expect(client.request('/api/session/ses_1/prompt')).rejects.toMatchObject({
      name: 'OpenCodeRequestError',
      status: 500,
      pathname: '/api/session/ses_1/prompt',
    });
  });

  it('maps transport failures (including an expired timeout) to a status-0 OpenCodeRequestError', async () => {
    const never = () =>
      new Promise<Response>((_resolve, reject) => {
        const signal = AbortSignal.timeout(20);
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    const client = createOpenCodeClient(
      { fallbackServerUrl: 'http://x', timeoutMs: 20 },
      { fetchImpl: never as typeof fetch, discover: () => null },
    );
    await expect(client.request('/api/session/ses_1/inbox')).rejects.toMatchObject({
      name: 'OpenCodeRequestError',
      status: 0,
    });
  });

  it('fails loudly when no server URL could be resolved (bridge route 500 semantics)', async () => {
    const client = createOpenCodeClient(
      { fallbackServerUrl: null },
      { discover: () => null, fetchImpl: vi.fn(async () => jsonResponse({})) },
    );
    await expect(client.request('/api/session/ses_1/inbox')).rejects.toMatchObject({
      name: 'OpenCodeRequestError',
      status: 0,
    });
    await expect(client.stream('/api/event')).rejects.toBeInstanceOf(OpenCodeRequestError);
  });

  it('validates config at the trust boundary and streams raw chunks', async () => {
    expect(() => openCodeClientConfigSchema.parse({ fallbackServerUrl: 'nope' })).toThrow();
    const chunks = ['data: x\n'];
    const fetchImpl = vi.fn(async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of chunks) c.enqueue(Buffer.from(chunk));
          c.close();
        },
      })),
    );
    const client = createOpenCodeClient(
      { fallbackServerUrl: 'http://x' },
      { fetchImpl, discover: () => null },
    );
    const body = await client.stream('/api/event');
    const received: (Uint8Array | string)[] = [];
    for await (const chunk of body) received.push(chunk);
    expect(Buffer.from(received[0] as Uint8Array).toString()).toBe('data: x\n');
  });
});

describe('createOpenCodeIntegration (public surface regression)', () => {
  // Runtime value exports of the stable entry point — an ADDITION here (e.g.
  // a re-exported client/factory/helper) fails this assertion. The type-only
  // surface is guarded source-level below (runtime enumeration cannot see it).
  // Sorted (the assertion compares against Object.keys().sort()).
  const EXPECTED_RUNTIME_EXPORTS = [
    'PortError',
    'WAKE_PROMPT',
    'composeWakePrompt',
    'createOpenCodeIntegration',
    'createSessionResolver',
  ];

  const indexSource = readFileSync(
    fileURLToPath(new URL('../src/integrations/opencode/index.ts', import.meta.url)),
    'utf8',
  );

  /** The WHITELISTED neutral surface — the ONLY names index.ts may export, in
   *  any form. Anything else (a client/helper/factory type, an interface, an
   *  alias) makes the exact-equality check fail. */
  const ALLOWED_EXPORTS = [
    // neutral event/session contract types
    'NormalizedEvent', 'SessionResolution', 'SessionResolver', 'SessionRole',
    // the three port interfaces
    'OpenCodeEventStream', 'OpenCodeSessionPort', 'OpenCodePromptPort',
    // neutral error contract
    'PortError', 'PortErrorCode',
    // integration surface
    'OpenCodeIntegration', 'OpenCodeIntegrationConfig', 'createOpenCodeIntegration',
    // the adapter's documented split points, exported CONSCIOUSLY (Phase 9
    // review ruling): the composition root and chat application consume only
    // this entry surface — no module-path reach-ins to sessions.ts/prompts.ts.
    'createSessionResolver', 'composeWakePrompt', 'WAKE_PROMPT',
  ];

  /** Parse `source` with the real TypeScript parser (the project's own
   *  `typescript` dependency). Regexes miss valid spellings (e.g. the
   *  `export type * from` form) and runtime enumeration cannot see type-only
   *  exports — the AST sees every form exactly as tsc does. */
  function parseSource(source: string): ts.SourceFile {
    return ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  }

  /** Every exported NAME in ANY export form, via the AST: named re-exports
   *  (value or type-only, incl. inline `export { type X }` and `as` renames —
   *  the EXPORTED name after `as` is collected), `export * as ns` namespace
   *  exports, `export interface/function/class/const/let/var/enum/…`
   *  declarations, and direct `export type X = …` aliases. `export * from`
   *  exports no single name, so it is rejected separately by
   *  `starOrDefaultExportViolations` below. */
  function exportedNames(sf: ts.SourceFile): string[] {
    const names: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node)) {
        if (ts.isNamespaceExport(node.exportClause)) names.push(node.exportClause.name.text);
        else if (ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) names.push(element.name.text);
        }
      } else if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
          }
        } else if ('name' in node && ts.isIdentifier((node as ts.NamedDeclaration).name!)) {
          names.push((node as ts.NamedDeclaration & { name: ts.Identifier }).name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return names.filter(Boolean);
  }

  /** Describes EVERY star re-export form — `export * from`, `export type *
   *  from`, `export * as ns from`, `export type * as ns from` — plus `export
   *  default`. Detected structurally (ExportDeclaration whose clause is
   *  absent or a NamespaceExport; the DefaultKeyword modifier), so no
   *  spelling — current or future TS — escapes by pattern mismatch. Empty
   *  array = clean. */
  function starOrDefaultExportViolations(sf: ts.SourceFile): string[] {
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node)) {
        const clause = node.exportClause;
        if (!clause || ts.isNamespaceExport(clause)) {
          violations.push(`star re-export at offset ${node.getStart(sf)}: ${node.getText(sf)}`);
        }
      } else if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        violations.push(`default export at offset ${node.getStart(sf)}: ${node.getText(sf)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return violations;
  }

  /** The `export function createOpenCodeIntegration` declaration, via the
   *  AST (export modifier required). */
  function findExportedFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
    let found: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === name &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        found = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  it('exports exactly the factory + documented split points + neutral error at runtime (fails on any addition)', () => {
    expect(Object.keys(opencodeIndex).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  it('exports exactly the whitelisted neutral names in ANY export form (type-only included)', () => {
    const sf = parseSource(indexSource);
    expect(exportedNames(sf).sort()).toEqual([...ALLOWED_EXPORTS].sort());
    // No star re-export of any form and no default export may exist.
    expect(starOrDefaultExportViolations(sf)).toEqual([]);
  });

  it('factory declaration parses to exactly one required, non-defaulted, non-rest parameter', () => {
    const sf = parseSource(indexSource);
    const fn = findExportedFunction(sf, 'createOpenCodeIntegration');
    expect(fn, 'createOpenCodeIntegration declaration not found in index.ts').not.toBeUndefined();
    // SHAPE, not bytes: multiline parameters, trailing commas and any other
    // formatting pass; a defaulted/optional/rest/added parameter fails.
    expect(fn?.parameters).toHaveLength(1);
    const config = fn?.parameters[0];
    expect(config?.name.getText(sf)).toBe('config');
    expect(config?.type?.getText(sf)).toBe('OpenCodeIntegrationConfig');
    expect(config?.questionToken, 'optional parameter (`config?:`)').toBeUndefined();
    expect(config?.initializer, 'defaulted parameter (`config = …`)').toBeUndefined();
    expect(config?.dotDotDotToken, 'rest parameter').toBeUndefined();
  });

  it('has no star exports of internals (source-level guard on index.ts)', () => {
    const sf = parseSource(indexSource);
    expect(starOrDefaultExportViolations(sf)).toEqual([]);
    expect(exportedNames(sf)).not.toContain('OpenCodeRequestError');
  });

  it('exposes ONLY the protocol-neutral ports — no client, no serverUrl, no raw transport', () => {
    const integration = createOpenCodeIntegration({ fallbackServerUrl: 'http://x' });
    expect(Object.keys(integration).sort()).toEqual(['events', 'prompts', 'sessions']);
    expect(Object.keys(integration.events).sort()).toEqual(['subscribe']);
    expect(Object.keys(integration.sessions).sort()).toEqual(['hasPendingUserInput']);
    // `isAvailable` is the NEUTRAL availability check (Phase 4 review ruling:
    // the bridge's `!SERVER_URL` fail-fast, as a boolean — no URL/transport
    // exposure; the whitelist export NAMES are unchanged, only this port's
    // runtime shape grew deliberately).
    expect(Object.keys(integration.prompts).sort()).toEqual(['isAvailable', 'prompt']);
    expect(typeof integration.events.subscribe).toBe('function');
    expect(typeof integration.prompts.isAvailable).toBe('function');
  });

  it('accepts no options/discovery override — a single config parameter only', () => {
    expect(createOpenCodeIntegration.length).toBe(1);
  });

  it('the exported error type is neutral: code + message only, no transport fields, no URL', () => {
    const err = new PortError('upstream-error', 'prompt delivery failed (upstream-error)');
    expect(Object.keys(err).sort()).toEqual(['code', 'name']);
    expect(err.message).toBe('prompt delivery failed (upstream-error)');
    expect(err).not.toHaveProperty('pathname');
    expect(err).not.toHaveProperty('status');
    expect(err).not.toHaveProperty('body');
    expect(err).not.toHaveProperty('cause');
    expect(err.message).not.toMatch(/https?:\/\//);
  });
});

describe('defaultDiscoverServerUrl', () => {
  // Only its null-tolerance is asserted here: spawning the real `opencode`
  // CLI would depend on the live environment (forbidden in tests).
  it('is a function that never throws', () => {
    expect(typeof defaultDiscoverServerUrl).toBe('function');
    expect(() => defaultDiscoverServerUrl()).not.toThrow();
  });
});
