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
| Components | **shadcn/ui** (style `base-nova`, built on **Base UI**) — `src/components/ui/*`, added with `npx shadcn@latest add <name>`. The shared `Button` is ours (cva + our palette); the registry's Button is NOT used |
| Styling | **Tailwind CSS v4** via `@tailwindcss/postcss`; semantic tokens in `globals.css` mapped to this dashboard's existing hexes |
| Icons | **lucide-react 1.x** |
| Toasts | **sonner** (`<Toaster>` in `app/layout.tsx`) |
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

### UI components (shadcn/ui)

- `web/components.json` — style `base-nova` (**Base UI** primitives), aliases
  `@/components` and `@/lib/utils`. Add components with
  `npx shadcn@latest add <name>` run from `web/`.
- **Do not let the CLI overwrite `src/components/ui/button.tsx` or
  `src/lib/utils.ts`.** The registry ships its own Button and a `cn` re-export
  of the third-party `cn` package; ours (cva + clsx + tailwind-merge) is the
  one in use. If the CLI writes `from "cn"`, rewrite it to `from "@/lib/utils"`.
- `init` also pulls `next/font/google` (Geist) and `next-themes`. Neither is
  used here: the layout keeps its own pre-hydration theme script, and
  `ui/sonner.tsx` is adapted to the local `useTheme`.
- Design tokens live in `src/app/globals.css` (mapped to this dashboard's
  existing palette). Change the look there, not per component.

## Tests and tooling

| Thing | Value |
|---|---|
| Test runner | **Vitest 3**, configured at the root: `vitest.config.ts` scopes it to `server/test/**` + `web/test/**` (`*.test.ts` **and** `*.test.tsx`), maps the `@/` alias, and loads `web/test/setup-dom.ts` (jsdom shims for `matchMedia` / `ResizeObserver` that the Base UI primitives touch) |
| Web tests | **jsdom 26** + **@testing-library/react 16** / `@testing-library/dom 10`. Logic suites are `.ts`; rendered component tests are `.tsx` with `// @vitest-environment jsdom` and `afterEach(cleanup)` (Vitest has no globals, so Testing Library's auto-cleanup does not register itself) |
| Gate | `npm test` (currently 46 files / 400 tests) |
| Onboarding | `node setup.mjs` — prerequisites, registry template, `projects/` |

## Machine constraints

**The repo lives on E:, an NTFS volume** (moved from F:, exFAT, on 2026-11-19).
That move removed both blockers this section used to describe:

1. **`next build` runs in place.** It used to abort on F: because webpack
   resolves through `fs.readlink`, and exFAT returns `EISDIR` for a regular file
   (`EISDIR ... readlink node_modules/next/dist/pages/_app.js`). On NTFS the
   same call returns `EINVAL`, and the export builds normally into `web/out/`.
2. **npm workspace linking is verified working on E:** (2026-11-20):
   `npm install <pkg> -w web` creates the workspace link and installs normally.
   The old F: failure is history; only a repo on exFAT still needs Developer
   Mode or elevation.
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
