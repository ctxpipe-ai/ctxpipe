# ctxpipe – Project index

## Overview

Monorepo for **ctxpipe**, managed with pnpm workspaces and Turbo. Apps live in `apps/`, shared packages in `packages/`.

## Architecture

- **Backend** (`apps/backend`): Hono-based service exposing REST API and MCP (via `@hono/mcp`), with LangChain/LangGraph for agent workflows (graphs in src/graphs/, model factory in src/config/models.ts). Deployable to Bun-based containers. Uses Drizzle + PostgreSQL, Better Auth (scaffolded), Zod (collocated), OpenRouter for LLM. Owns `repositories` table and all migrations. See [apps/backend/adr/0001-backend-service-stack-and-runtime.md](apps/backend/adr/0001-backend-service-stack-and-runtime.md), [apps/backend/adr/0004-langgraph-integration.md](apps/backend/adr/0004-langgraph-integration.md).
- **Codesearch** (`apps/codesearch`): Bun service that orchestrates Zoekt (search proxy, on-demand indexing, file serving). Read-only access to Postgres `repositories`; structure mirrors backend. OpenAPI + Zod for all routes. See [apps/codesearch/adr/0001-codesearch-zoekt-orchestration.md](apps/codesearch/adr/0001-codesearch-zoekt-orchestration.md).

## User-defined namespaces

- (Leave blank – user populates)

## Components

- **backend** – `apps/backend`: REST + MCP + LangGraph server; entrypoint `src/server.ts` (Bun). LangGraph graphs in `src/graphs/`; model factory in `src/config/models.ts`. Owns Drizzle schema and migrations (including `repositories`).
- **codesearch** – `apps/codesearch`: Zoekt orchestration (POST /search proxy, POST /:repoId/index clone+index, GET/POST file routes); entrypoint `src/server.ts` (Bun). Mirrors backend `repositories` schema and performs lifecycle update for `index_ready`; repo cache and index paths fixed in code.
- **interactionGraph** – `apps/backend/src/graphs/interactionGraph/graph.ts` with node in `apps/backend/src/graphs/interactionGraph/nodes/codeInterpreter.ts` (`codeInterpretter`): LangGraph entrypoint for generic repository-aware Q&A, implemented with LangChain v1 `createAgent`; node instructions are inline with node implementation and repositories snapshot is provided in-system as TOON.
- **codeIngestionGraph** – `apps/backend/src/graphs/codeIngestionGraph/graph.ts` with first node in `apps/backend/src/graphs/codeIngestionGraph/nodes/reindex.ts`: queue-driven ingestion graph that currently triggers codesearch reindex for a repository and is invoked by backend queue worker jobs.
- **backend tools** – `apps/backend/src/tools/`: strongly typed LangChain tools (`list_repositories`, `search`, `list_files`, `get_file`) using `repositoryId` (`repo_` prefix) and TOON-encoded tool payloads.
- **backend DB context** – `apps/backend/src/db/client.ts`: provides `createDb()` (reads `process.env` internally), AsyncLocalStorage-backed `withDbContext(...)`, `getDb()`, and `getQueryDb()` for request-scoped database access.
- **backend repository model** – `apps/backend/src/models/repositories.ts`: central repository DB access helpers with Drizzle query API (`db.query.repositories.*`) and org scoping.
- **backend code ingestion queue** – `apps/backend/src/domain/codeIngestion/queue.ts` and `apps/backend/src/domain/codeIngestion/worker.ts`: enqueue + processing services backed by Postgres tables (`repository_ingestion_queue`, `repository_ingestion_errors`) with serialized per-repository claims, retries, and terminal error logging.
- **backend langsmith embedded API** – `apps/backend/src/langsmith/server.ts` + `apps/backend/src/routes/langsmith.ts`: in-process LangGraph API mounted at `/langsmith` behind `ENABLE_LANGSMITH`; initializes filesystem-backed langgraph-api storage and registers graphs from `src/graphs/index.ts` exports.
- **backend auth core** – `apps/backend/src/auth/config.ts`: Better Auth server wiring with Drizzle adapter (`usePlural`), experimental joins enabled, organization + two-factor + passkey + bearer + device authorization + oauth provider plugins, and social providers (GitHub/Google/Microsoft) when env credentials are present.
- **backend upstream JWT signer** – `apps/backend/src/auth/upstreamJwt.ts`: shared HS256 JWT signer for backend-to-upstream service requests; emits short-lived bearer tokens with subject, organization, principal type, issuer, and audience claims.
- **backend auth context route** – `apps/backend/src/routes/v1/auth.ts` (`GET /api/v1/auth/me`): authenticated user/session context endpoint that reports the inferred last login method from latest linked auth account provider.
- **codesearch JWT auth boundary** – `apps/codesearch/src/auth/jwt.ts` + `apps/codesearch/src/app/app.ts`: verifies backend-issued bearer JWT on API routes and injects claims-derived org context into request scope.
- **ui better-auth-ui integration** – `apps/ui/src/providers.tsx` + auth/account/organization routes under `apps/ui/src/routes/*`: TanStack Start app wrapped with `AuthUIProviderTanstack` and `AuthQueryProvider`, using `@daveyplate/better-auth-ui` `AuthView` / `AccountView` / `OrganizationView` containers for complete auth and settings UX.

## Patterns

- Zod schemas are collocated with the code they validate (no central `src/schemas`).
- UI icon asset naming pattern: keep files in `apps/ui/public/icons` URL-safe lowercase kebab-case and include a size suffix (`-<width>x<height>`) before the extension.
- UI generated app-icon pattern: keep generated variants in `apps/ui/public/icons` using kebab-case + size suffixes, except favicon which is a special-case root asset at `apps/ui/public/favicon.ico`; `manifest.json` should reference root `favicon.ico` and `icons/...` for PNG variants.
- TanStack devtools production pattern in `apps/ui`: keep `devtools()` in `vite.config.ts` (default strips devtools code from production builds) and gate `<TanStackDevtools />` in routes with `import.meta.env.DEV` for explicit runtime behavior.
- Favicon generation note: when `sips` fails to write `.ico` in this environment, generate `apps/ui/public/favicon.ico` from the selected 512 PNG via Python Pillow with embedded sizes (16/24/32/48/64).
- Geist typography pattern in `apps/ui`: install `geist` via npm package, source variable `.woff2` files from the package into `public/fonts`, and map Tailwind fonts via `--font-geist-sans` / `--font-geist-mono` variables in `src/styles.css`.
- Geist fallback pattern in `apps/ui`: register Geist Sans/Mono and only the needed Geist Pixel faces via `@font-face`, keep Geist variable weights (`100 900`) and Pixel weight (`500`), keep pixel tokens fallbacking first to `"Geist Mono"`, and use concise/common system fallback stacks instead of long-tail font lists.
- UI testing organization pattern: keep stories/tests collocated with related code; do not keep top-level `src/stories` or generic `src/test` folders. Vitest is reserved for non-visual logic (helpers/functions), while component verification is done in Storybook.
- Biome config pattern for `apps/ui`: use the root `biome.jsonc` (no nested `apps/ui/biome.json`) and enable `css.parser.tailwindDirectives` at root so Tailwind at-rules (`@plugin`, `@theme`, `@apply`) parse correctly.
- Editor warning suppression pattern for Tailwind CSS files: configure workspace `.vscode/settings.json` with `"css.lint.unknownAtRules": "ignore"` to silence VS Code CSS language-service warnings for Tailwind at-rules while keeping Biome linting active.
- ADRs in `adr/` for major tooling and architecture decisions (see [adr/README.md](adr/README.md)).
- Dependency typing workarounds are handled via `pnpm patch` files under `patches/` (instead of editing files in `node_modules` directly).
- For `@hono/zod-openapi`, avoid local `createRoute` module overrides in app code; prefer dependency patching with minimal const-generic + schema inference relaxations to preserve `c.req.valid("json")` typing.
- When patching `@hono/zod-openapi` schema inference, keep request and response inference aligned: if request body typing is relaxed from `ZodType` to broader schema acceptance, also relax response `ExtractContent` typing (and route it through a shared helper) to avoid `TypedResponse<never, ...>` regressions in `app.openapi(...)` handlers.
- In `@hono/zod-openapi` declaration patches, avoid `Record<"schema", any>` direct indexing (`...["schema"]`) because it collapses request/response schema inference to `any`; use `Record<"schema", infer Schema>` and infer input/output/content from `Schema` instead.
- Codesearch indexing flow: `POST /{repoId}/index` removes prior clone, clones to `/data/repo-cache/<org_id>/<repo_id>`, then runs `zoekt-index` with a generated `.meta` containing Zoekt repo `ID` from backend `repositories.zoekt_repo_id`, writing shards to `/data/zoekt-index`.
- Backend repository creation triggers indexing asynchronously via codesearch and returns immediately; repository readiness is tracked in `repositories.index_ready` (default `false`, set to `true` after successful indexing in codesearch).
- Backend repository creation now resolves default branch/hash via codesearch `POST /{repoId}/resolve-ref`, enqueues ingestion jobs in Postgres, and processes them through `codeIngestionGraph` worker loop (2 retries before moving failures to `repository_ingestion_errors`).
- Docker local stack runs a dedicated internal `zoekt-webserver` service (`-rpc`, port 6070 on compose network); codesearch proxies `/search` to `http://zoekt-webserver:6070/api/search`.
- Codesearch route organization: keep route files focused on OpenAPI schema + handlers; move clone/index/repository access/path resolution into `src/domain/*` modules (e.g. `src/domain/indexing/service.ts`, `src/domain/repositories/*`).
- Ingestion testing pattern: backend ingestion flow tests live under `apps/backend/tests/` (route tests + worker policy/transition tests), and codesearch resolve-ref coverage uses Vitest in `apps/codesearch/tests/` (domain command parsing + route behavior with mocked repository access).
- Tool organization pattern: reusable agent tools live under `src/tools`; graph-specific instructions and nodes stay under `src/graphs/<graphName>/`.
- Tool payload pattern: serialize structured tool outputs to TOON before passing them to the LLM to reduce token usage.
- Chat graph persistence pattern: `apps/backend/src/graphs/chatGraph/graph.ts` compiles with a Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres`) when `DATABASE_URL` is present and falls back to in-memory when it is not.
- `src/tools/` discipline: only agent-callable tools belong there; shared helpers should live outside (for example in `src/lib`).
- Tool export pattern: each tool file exports only its single `*Tool` entrypoint (inline handler + schema) to keep typing and wiring simple.
- DB access pattern: routes are wrapped in AsyncLocalStorage DB middleware; app code should use `getDb()` / `getQueryDb()` instead of passing DB instances via request context.
- Query pattern: prefer Drizzle query API (`db.query.<table>.findMany/findFirst`) and enforce org filtering in SQL-level conditions rather than runtime post-filtering.
- LangSmith integration pattern: mount LangGraph API in-process (no subprocess/proxy), gate with `ENABLE_LANGSMITH`, and resolve graph specs from `./src/graphs/index.ts:{exportName}` rather than generating `langgraph.json`.
- Better Auth + Drizzle pattern in `apps/backend`: configure adapter with `usePlural: true` and pass schema aliases (`user/users`, `session/sessions`, etc.), and enable `experimental.joins` for relational fetch optimization.
- Auth secret safety pattern: do not provide code-level default `AUTH_SECRET`; require explicit env configuration and enforce a minimum of 32 characters to fail fast on insecure or missing setup.
- Better Auth trusted-origin pattern in `apps/backend`: when `AUTH_ALLOWED_ORIGINS` is not configured, restrict trusted origins to a strict same-origin default derived from the auth base URL, and for `/api/auth/*` requests resolve auth config by request origin so self-hosted deployments work across different host/scheme combinations without opening cross-origin trust.
- Better Auth schema ownership pattern in `apps/backend`: auth DB objects are managed by Better Auth tooling/capabilities and are not maintained as hand-authored Drizzle schema files in app source.
- Better Auth schema layout pattern in `apps/backend`: keep generated Better Auth Drizzle exports in `apps/backend/src/db/schema/auth.ts`; compose them into `apps/backend/src/db/schema.ts` and pass explicit `{ ...schema, ...relations }` to `drizzleAdapter(...)` so plural auth models resolve deterministically.
- Tenant propagation pattern between backend and codesearch: backend signs short-lived HS256 bearer JWTs for every outbound codesearch call; codesearch validates signature + issuer + audience and scopes repository access strictly by `orgId` claim instead of `MOCK_ORG_ID`.
- Repository SQL safety pattern in `apps/backend`: never query repositories without tenant filter; repository reads in models/tools must include `orgId` and routes should consume only validated `c.get("orgId")` context (no header fallback).
- Agent tool tenancy pattern in `apps/backend`: LLM tool schemas must never accept `orgId` as input; tools resolve org scoping from trusted Hono request context via `hono/context-storage` `getContext()` by reading `session.activeOrganizationId`, then apply SQL org filters.
- Better Auth UI pattern in `apps/ui`: keep route URLs stable (`/sign-in`, `/reset-password`, `/account`) as wrappers where useful, and expose full dynamic auth/settings flows via `/auth/$authView`, `/account/$accountView`, and `/organization/$organizationView` backed by `@daveyplate/better-auth-ui` containers.
- UI icon library migration pattern in `apps/ui`: use `@tabler/icons-react` (not `lucide-react`) for component icons, with Tabler's `Icon*` symbol names mapped semantically from prior Lucide glyphs while preserving existing size/class/ARIA props.
- Backend unmatched-route fallback pattern: keep explicit backend routes mounted first, then add a final `app.all("*")` proxy in `apps/backend/src/app/app.ts` that forwards unknown paths to the UI origin from `UI_PROXY_URL` using Hono's `proxy()` helper; define auth middleware in `apps/backend/src/auth/withAuth.ts` and apply it directly inside `apps/backend/src/routes/v1/index.ts` via `v1.use("*", withAuth)` (non-configurable route registration), instead of path-prefix checks in a global middleware.
- Docker-compose UI logging pattern: keep `ui-bun` on the default `pnpm --filter @ctxpipe/ui dev` command so warnings remain visible; there is no clean built-in switch in this setup to hide only Vite startup banner lines while preserving warning-level output.
