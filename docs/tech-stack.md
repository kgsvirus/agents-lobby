# Tech stack

The reference list for anyone (human or agent) picking up work in this repo.
Every version below is the declared range; `package.json` files are the source
of truth, this document is the map. Last verified 2026-11-19.

## Runtime and workspaces

| Thing | Value |
|---|---|
| Node | **24+** (`engines.node` in root and `server/`) |
| Package manager | npm **workspaces**: `server/`, `web/` |
| Module system | ESM (`"type": "module"` everywhere) |
| Language | **TypeScript 5.9**, strict mode |

## Backend — `server/`

| Concern | Stack |
|---|---|
| HTTP | **Fastify 5** |
| Validation | **zod 4** (`shared/schemas`, `config/index.ts`) |
| Persistence | **better-sqlite3 12** + **Drizzle ORM 0.45**; migrations via **drizzle-kit 0.31** (`npm run db:generate -w server`) |
| Database file | `.data/messages.db` (gitignored) |
| Real-time | Server-Sent Events at `/api/events`, with checkpoint / `Last-Event-ID` catch-up |
| Registry | `config/agents.json`, re-read per request (no restart, no db mirror) |
| Dev / build | `tsx` (`npm run dev -w server`) · `tsc` (`npm run build -w server`) |

Architecture is a **modular monolith**: `modules/<name>/{domain,application,infrastructure,presentation}`,
plus `integrations/opencode` (the only place OpenCode wire formats are known),
`infrastructure/` (database, event bus, registry reader) and a composition root
in `src/app.ts`. Binding layer rule: `domain/` and `application/` import neither
Fastify, drizzle, nor OpenCode shapes. Detail: `docs/migration/architecture.md`,
API/config reference: `server/README.md`.

## Frontend — `web/`

| Concern | Stack |
|---|---|
| Framework | **Next.js 15** (App Router) |
| UI runtime | **React 19** |
| Language | **TypeScript 5.9** |
| Styling | **Tailwind CSS v4** via `@tailwindcss/postcss` |
| Components | shadcn-style, hand-rolled: `class-variance-authority` + `clsx` + `tailwind-merge` (`src/components/ui/button.tsx`) — no Radix installed |
| Icons | **lucide-react 1.x** |
| Delivery | `output: 'export'` → static `web/out`, served by Fastify at `/ui`; `basePath: '/ui'` |
| Dev server | `next dev` proxies `/api`, `/send`, `/prompt` to Fastify (`127.0.0.1:3006`, overridable with `LOBBY_API_TARGET`) |

The dashboard is **client-side only**: no SSR data fetching, no Server Actions,
no database access from the UI (`web/next.config.ts` explains why the static
export is safe).

### Icons (lucide-react)

- Guide: <https://lucide.dev/guide/> · React guide: <https://lucide.dev/guide/react/> · icon search: <https://lucide.dev/icons/>
- Import per icon — `import { Settings } from 'lucide-react'` — never a dynamic
  lookup by string; per-icon imports are what makes tree-shaking work.
- v1 sets `aria-hidden="true"` on icons by default, so **an icon-only control
  needs its own `aria-label`**; a `title` is not an accessible name.
- v1 removed all brand icons.
- Sizing/colour/stroke-width defaults can be set once with `<LucideProvider>`
  from `lucide-react`.

## Tests and tooling

| Thing | Value |
|---|---|
| Test runner | **Vitest 3**, configured at the root: `vitest.config.ts` scopes it to `server/test/**` + `web/test/**` |
| Web tests | **jsdom 26** + **@testing-library/react 16** / `@testing-library/dom 10` |
| Gate | `npm test` (currently 44 files / 390 tests) |
| Onboarding | `node setup.mjs` — prerequisites, registry template, `projects/` |

## Machine constraints

**The repo lives on E:, an NTFS volume** (moved from F:, exFAT, on 2026-11-19).
That move removed both blockers this section used to describe:

1. **`next build` runs in place.** It used to abort on F: because webpack
   resolves through `fs.readlink`, and exFAT returns `EISDIR` for a regular file
   (`EISDIR ... readlink node_modules/next/dist/pages/_app.js`). On NTFS the
   same call returns `EINVAL`, and the export builds normally into `web/out/`.
2. **npm workspace linking is still unproven on this machine.** Creating a
   *symlink* needs elevation or Developer Mode here (tested on both volumes);
   *junctions* work without it. If `npm install` fails with
   `EISDIR/EPERM ... symlink web -> node_modules/@agents-lobby/web`, enable
   Developer Mode or run the install from an elevated shell.
3. Historical workaround for F: (no longer needed): `npm install <pkg> -w <ws>
   --package-lock-only`, then place the package under `node_modules/<pkg>` from
   its registry tarball, verifying the sha512 against the lockfile; and build
   the export in a separate NTFS clone. Keep only the integrity check habit.

`npm test`, `tsc --noEmit`, `next build` and the Fastify server all run from E:.

## Where the rest lives

- Human-facing overview and setup: `README.md` (§ Tech stack points here)
- Architecture record: `docs/migration/architecture.md`
- Server API/config reference: `server/README.md`
- Lobby protocol rules: `PROTOCOL.md`
- Agent templates: `.placeholder/agent/`
