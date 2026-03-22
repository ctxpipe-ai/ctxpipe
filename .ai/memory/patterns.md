# Project Patterns

## Contents

Staged loading: pick **one** section for your task; avoid putting this entire file in context when a single topic suffices. Match section to `@topic` when appending new bullets (see `memory-sync`).

| Section | `@topic` |
|---------|----------|
| [Code conventions](#code-conventions) | `monorepo` |
| [Architecture patterns](#architecture-patterns) | `architecture` |
| [Backend & Codesearch](#backend--codesearch) | `backend` |
| [Authentication & Auth](#authentication--auth) | `auth` |
| [UI (apps/ui)](#ui-appsui) | `ui` |
| [Backend routing](#backend-routing) | `backend` |
| [Testing patterns](#testing-patterns) | `testing` |

<!-- @topic: monorepo -->
## Code Conventions

- **Environment variables** — reserve for values that **differ by deployment** (dev/staging/prod) or that **operators or customers must supply** (secrets, base URLs, resource limits for their infra). Do **not** use env to toggle **product features** or **internal logic/defaults**; keep those as normal code (or committed config) unless a value is genuinely environment-specific or tenant-supplied
  <!-- @category: convention -->
- **Biome** for linting and formatting across the monorepo
- **Zod schemas collocated** with the modules they describe (routes, domain, DB models) — no central `src/schemas`
  <!-- @category: convention -->
- **Avoid pulling to globals** — inline config/one-off values unless reused in more than one place
- **No premature helper extraction** — keep single-use logic (truncation, slicing, small transforms) inline in the tool or node that needs it; only move to `src/lib` or a shared helper when a **second** call site exists
  <!-- @category: convention -->
- **TypeScript strict mode**
- **DB migrations** only in `apps/backend`; generate via `pnpm run db:generate`, never hand-write migration SQL
- **Transactions** — always wrap multi-table operations in `db.transaction(async (tx) => { ... })`
- **ADRs** in `.ai/memory/decisions/` for major tooling and architecture decisions (single source of truth; no repo `adr/` directories)
  <!-- @category: convention -->
- **Dependency typing workarounds** via `pnpm patch` under `patches/` (not editing node_modules directly)
  <!-- @category: convention -->

<!-- @topic: architecture -->
## Architecture Patterns

- **Hono apps** for both backend and codesearch — REST via `@hono/zod-openapi`, MCP via `@hono/mcp`
- **Domain services** shared between REST routes and MCP tools
- **Public API routes** org-scoped: `/:orgSlug/api/v1`
- **OpenAPI spec** at `/.docs/openapi` (JSON), Scalar API reference at `/.docs/api-reference`
- **IDs**: TEXT type, `<prefix>_<base32 encoded uuid>` (e.g. `repo_...`)
- **Local dev**: **`pnpm dev`** — portless + Turbo (host; see root [AGENTS.md](../../AGENTS.md)); **`pnpm dev:docker`** — full stack in Docker (`docker compose up`)
- **@hono/zod-openapi**: avoid local `createRoute` overrides in app code; prefer dependency patching with minimal const-generic + schema inference relaxations to preserve `c.req.valid("json")` typing
  <!-- @category: pattern -->
- **@hono/zod-openapi schema inference**: keep request and response aligned; if request body typing is relaxed, also relax response `ExtractContent` (shared helper) to avoid `TypedResponse<never, ...>` regressions
  <!-- @category: pattern -->
- **@hono/zod-openapi declaration patches**: avoid `Record<"schema", any>` direct indexing (collapses inference to `any`); use `Record<"schema", infer Schema>` and infer input/output/content from `Schema`
  <!-- @category: pattern -->

<!-- @topic: backend -->
## Backend & Codesearch

  <!-- @category: pattern -->
- **Tool organization**: reusable agent tools under `src/tools`; graph-specific instructions and nodes under `src/graphs/<graphName>/`
  <!-- @category: pattern -->
- **Tool payload**: serialize structured tool outputs to TOON before passing to LLM to reduce token usage
  <!-- @category: pattern -->
- **src/tools discipline**: only agent-callable tools in `src/tools`; shared helpers in `src/lib` (or similar)
  <!-- @category: pattern -->
- **Tool export**: each tool file exports only its single `*Tool` entrypoint (inline handler + schema)
  <!-- @category: pattern -->
- **DB access**: init once at startup (`initDb`); access via AsyncLocalStorage helpers — `withSystemDbContext(...)` for system ops, `withOrgDbContext(orgId, ...)` for tenant-scoped; do not pass DB via request context
  <!-- @category: pattern -->
- **Query**: prefer Drizzle query API (`db.query.<table>.findMany/findFirst`); enforce org filtering in SQL, not runtime post-filtering
  <!-- @category: pattern -->
- **LangSmith integration**: mount LangGraph API in-process (no subprocess/proxy), gate with `ENABLE_LANGSMITH`, resolve graph specs from `./src/graphs/index.ts:{exportName}` (no generated `langgraph.json`)
  <!-- @category: pattern -->

<!-- @topic: auth -->
## Authentication & Auth

  <!-- @category: pattern -->
- **Auth provider UI discovery** — `@daveyplate/better-auth-ui` shows available social providers from backend config; no manual UI updates when adding providers
  <!-- @category: pattern -->
- **Auth secret**: no code-level default `AUTH_SECRET`; require explicit env, minimum 32 characters
  <!-- @category: pattern -->
- **Better Auth trusted-origin**: when `AUTH_ALLOWED_ORIGINS` unset, restrict to strict same-origin from auth base URL; for `/.auth/*` resolve auth config by request origin for self-hosted deployments
  <!-- @category: pattern -->
- **Better Auth schema ownership**: auth DB objects managed by Better Auth tooling; not hand-authored Drizzle schema in app
  <!-- @category: pattern -->
- **Better Auth schema layout**: generated Drizzle exports in `apps/backend/src/db/schema/auth.ts`; compose in `schema.ts`, pass explicit `{ ...schema, ...relations }` to `drizzleAdapter(...)` for plural auth models
  <!-- @category: pattern -->
- **Unified object ID**: `apps/backend/src/lib/id.ts` — uuid v7 + `@scure/base` base32nopad, `<prefix>_<base32(uuidv7-bytes)>`; Better Auth `advanced.database.generateId` delegates after model→type slug mapping
  <!-- @category: pattern -->
- **Repository ID validation**: `repositoryIdSchema` accepts legacy `repo_[A-Z2-7]+` and new UUIDv7 base32hex `repo_[0-9a-v]+` for mixed records
  <!-- @category: pattern -->
- **Tenant propagation**: backend signs short-lived HS256 bearer JWTs for codesearch; codesearch validates signature + issuer + audience, scopes repo access by `orgId` claim (no `MOCK_ORG_ID`)
  <!-- @category: pattern -->
- **Repository SQL safety**: never query repositories without tenant filter; models/tools include `orgId`; routes use only validated `c.get("orgId")` (no header fallback)
  <!-- @category: pattern -->
- **Agent tool tenancy**: LLM tool schemas must not accept `orgId`; tools get org from trusted Hono context via `getContext()` → `session.activeOrganizationId`, then apply SQL org filters
  <!-- @category: pattern -->
- **Better Auth UI (apps/ui)**: public `/` lightweight; auth/account under `/.auth/*`; org settings under `/$organizationSlug/organization/$organizationView`; `@daveyplate/better-auth-ui` containers
  <!-- @category: pattern -->

<!-- @topic: ui -->
## UI (apps/ui)

- **UI icon assets**: `apps/ui/public/icons` — URL-safe lowercase kebab-case, size suffix `-<width>x<height>` before extension
  <!-- @category: convention -->
- **Generated app-icon**: variants in `apps/ui/public/icons` with kebab-case + size suffixes; favicon at root `apps/ui/public/favicon.ico`; `manifest.json` references root favicon and `icons/...` PNGs
  <!-- @category: convention -->
- **TanStack devtools**: keep `devtools()` in `vite.config.ts` (strips from prod); gate `<TanStackDevtools />` in routes with `import.meta.env.DEV`
  <!-- @category: convention -->
- **Favicon generation**: if `sips` fails for `.ico`, generate `apps/ui/public/favicon.ico` from 512 PNG via Python Pillow with embedded sizes (16/24/32/48/64)
  <!-- @category: convention -->
- **UI testing**: stories/tests collocated with code; no top-level `src/stories` or generic `src/test`; Vitest for non-visual logic; Storybook for component verification
  <!-- @category: pattern -->
- **Biome (apps/ui)**: use root `biome.jsonc` (no nested `apps/ui/biome.json`); enable `css.parser.tailwindDirectives` at root for Tailwind at-rules
  <!-- @category: convention -->
- **Tailwind CSS in editor**: workspace `.vscode/settings.json` — `"css.lint.unknownAtRules": "ignore"` to silence VS Code warnings for Tailwind at-rules; Biome lint stays active
  <!-- @category: convention -->
- **UI component file organization**: one component per file unless trivial sub-component colocated in same file
  <!-- @category: convention -->
- **UI icon library**: use `@tabler/icons-react` (not lucide-react); map Tabler `Icon*` names semantically from prior Lucide glyphs; keep size/class/ARIA props
  <!-- @category: convention -->
- **App shell layout**: authenticated org/settings inside `AppShell` (two-column flex; SideNav + main); unauthenticated `/.auth/*` outside shell
  <!-- @category: pattern -->
- **Component API boundary**: do not expose internal state/persistence (e.g. localStorage keys) as public props for testing/story convenience; drive variations via interaction/wrappers
  <!-- @category: pattern -->
- **Docker-compose UI logging**: keep `ui-bun` on default `pnpm --filter @ctxpipe/ui dev` so warnings visible; no clean switch to hide only Vite banner while keeping warning output
  <!-- @category: pattern -->

<!-- @topic: backend -->
## Backend Routing

- **Unmatched-route fallback**: mount explicit backend routes first; final `app.all("*")` in `apps/backend/src/app/app.ts` proxies unknown paths to UI origin from `UI_PROXY_URL` via Hono `proxy()`. Auth middleware in `withAuth.ts`, applied in `src/routes/v1/index.ts` via `v1.use("*", withAuth)` (no path-prefix checks in global middleware)
  <!-- @category: pattern -->

<!-- @topic: testing -->
## Testing Patterns

- **apps/ui**: Vitest + Testing Library for component tests, Storybook for exploration
- **Backend and codesearch**: tests collocated under `src/` next to subjects (see Ingestion testing above)

---
*Last updated: 2026-03-21*
