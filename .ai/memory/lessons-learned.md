# Lessons learned

Highest-priority confirmed rules for agents. Migrated from former `patterns.md` (ADR-024).

## Entries

### Environment variables
- **Rule:** reserve for values that **differ by deployment** (dev/staging/prod) or that **operators or customers must supply** (secrets, base URLs, resource limits for their infra). Do **not** use env to toggle **product features** or **internal logic/defaults**; keep those as normal code (or committed config) unless a value is genuinely environment-specific or tenant-supplied
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Non-secret public URLs
- **Rule:** (e.g., JWKS endpoints) — hardcode as constants; avoid env plumbing unless the value must be operator/tenant-supplied
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Biome
- **Rule:** for linting and formatting across the monorepo
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Zod schemas collocated
- **Rule:** with the modules they describe (routes, domain, DB models) — no central `src/schemas`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Avoid pulling to globals
- **Rule:** inline config/one-off values unless reused in more than one place
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### No premature helper extraction
- **Rule:** keep single-use logic (truncation, slicing, small transforms) inline in the tool or node that needs it; only move to `src/lib` or a shared helper when a **second** call site exists
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### TypeScript strict mode
- **Rule:** TypeScript strict mode
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Avoid `unknown` as a default or escape-hatch type
- **Rule:** it is easy to follow with assertions or casts that drop compile-time safety; prefer concrete types, generics, Zod-validated shapes, or discriminated unions. Reserve `unknown` for true unknown external input only when it is immediately narrowed or parsed. **`any` disables checking entirely** — avoid except in unavoidable interop or documented patches (see @hono/zod-openapi notes above)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### DB migrations
- **Rule:** only in `apps/backend`; generate via `pnpm run db:generate`, never hand-write migration SQL
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Transactions
- **Rule:** always wrap multi-table operations in `db.transaction(async (tx) => { ... })`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### ADRs
- **Rule:** in `.ai/memory/decisions/` for major tooling and architecture decisions (single source of truth; no repo `adr/` directories)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Dependency typing workarounds
- **Rule:** via `pnpm patch` under `patches/` (not editing node_modules directly)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Changesets scope for examples
- **Rule:** keep private runnable examples (e.g. `@ctxpipe/aws-cdk-self-host`) in `.changeset/config.json` `ignore` so release PRs for publishable packages do not churn example package versions.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Changeset CI guard
- **Rule:** PRs run `changeset status --since=origin/main` (release-bot PRs skipped); fails when a versionable workspace package changed without a changeset ([ADR-020](decisions/ADR-020-changeset-ci-guard-policy.md)). Authors/reviewers pick the package: `@ctxpipe/aws-cdk` for app/deploy-affecting work; the changed publishable package under `packages/*`. CI does not verify package names.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Protected `main` release policy
- **Rule:** do not rely on release-bot commits to `main`; for `@ctxpipe/aws-cdk`, generate `src/pinned-service-image-tag.ts` at build/publish time and keep it gitignored/untracked.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Hono apps
- **Rule:** for both backend and codesearch — REST via `@hono/zod-openapi`, MCP via `@hono/mcp`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Domain services
- **Rule:** shared between REST routes and MCP tools
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Public API routes
- **Rule:** org-scoped: `/:orgSlug/api/v1`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### OpenAPI spec
- **Rule:** at `/.docs/openapi` (JSON), Scalar API reference at `/.docs/api-reference`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### IDs
- **Rule:** TEXT type, `<prefix>_<base32 encoded uuid>` (e.g. `repo_...`)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Local dev
- **Rule:** **`pnpm dev`** — portless + Turbo (host; see root [AGENTS.md](../../AGENTS.md)); **`pnpm dev:infra`** — Compose **`infra`** profile (Postgres, FalkorDB, OTEL, Zoekt). **Small-scale container deploy**: **`pnpm start`** — Compose **`deploy`** profile (production images); see [ADR-015](decisions/ADR-015-docker-compose-profiles-and-small-scale-deploy.md)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Portless (host dev)
- **Rule:** root **`devDependency`**; use **`pnpm exec portless`** from repo root (see [`scripts/dev-apps.sh`](../../scripts/dev-apps.sh)). Canonical origin when proxy binds **443**: **`https://app.ctxpipe.localhost`**; align env with **`pnpm exec portless get`**. [portless.sh](https://portless.sh/).
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Universal CLI UX
- **Rule:** publish the unscoped `ctxpipe` package from `packages/cli`; primary entry is **`npx ctxpipe`**; human path `npx ctxpipe init`; agent/CI uses explicit flags (`--org`, `--agents`/`--client`, `--scope`, `--non-interactive`, `--json`, `--base-url`, …). Setup auth prefers **OS keychain** via `@napi-rs/keyring`, with file fallback under `~/.config/ctxpipe/` when keyring is unavailable. Full flag list per command: `npx ctxpipe <cmd> --help` (commander.js).
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Local agent memory
- **Rule:** Durable memory is Markdown under `.ai/memory/` with `index.md` routers; host hooks append gitignored candidates under `events/`; promote via capture skills; no local memory search daemon. See [ADR-024](decisions/ADR-024-markdown-only-local-memory-capture.md).
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** ADR-024 migration

### `@ctxpipe/aws-cdk` self-host deploy ordering
- **Rule:** run Postgres migrations as an internal CloudFormation custom resource that launches ECS `MigrateTask` (`RunTask` + `DescribeTasks` polling), then add explicit dependencies from ECS services to that custom resource so app rollout waits for schema readiness; keep migration task definition output internal-only.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### `@ctxpipe/aws-cdk` auth secret ownership
- **Rule:** treat Better Auth `AUTH_SECRET` as construct-managed infrastructure secret; generate it in Secrets Manager and inject task env from a named JSON key (`AUTH_SECRET`) instead of requiring callers to pass secret values into CDK props/context.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### `@ctxpipe/aws-cdk-self-host` CDK command orchestration
- **Rule:** define Turbo task `cdk:exec` with `dependsOn: ["^build"]` and wrap user-facing `pnpm cdk ...` to run through Turbo so workspace dependency `@ctxpipe/aws-cdk` is built automatically before synth/deploy/destroy flows.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### @hono/zod-openapi
- **Rule:** avoid local `createRoute` overrides in app code; prefer dependency patching with minimal const-generic + schema inference relaxations to preserve `c.req.valid("json")` typing
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### @hono/zod-openapi schema inference
- **Rule:** keep request and response aligned; if request body typing is relaxed, also relax response `ExtractContent` (shared helper) to avoid `TypedResponse<never, ...>` regressions
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### @hono/zod-openapi declaration patches
- **Rule:** avoid `Record<"schema", any>` direct indexing (collapses inference to `any`); use `Record<"schema", infer Schema>` and infer input/output/content from `Schema`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Connector OAuth popup completion
- **Rule:** when the backend owns an OAuth callback, return a tiny same-origin HTML relay that writes the result to `localStorage` and closes the popup; the opener should listen for the storage event and also poll for popup close before refreshing connector queries. Avoid routing popup completion through the full UI app unless the user intentionally continues setup inside that window.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### `connections.config` (JSONB)
- **Rule:** read through the Zod schema for that `type` (e.g. `forgeConnectionConfigSchema` via `tryParseForgeConnectionConfig` or `parseForgeConnectionConfig`), not ad hoc `typeof`/`trim` on `Record<string, unknown>`. Centralize defaults and normalisation (trim, empty→null) in the schema with `preprocess`/`transform` where needed
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Tool organization
- **Rule:** reusable agent tools under `src/tools`; graph-specific instructions and nodes under `src/graphs/<graphName>/`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Tool payload
- **Rule:** serialize structured tool outputs to TOON before passing to LLM to reduce token usage
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### src/tools discipline
- **Rule:** only agent-callable tools in `src/tools`; shared helpers in `src/lib` (or similar)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Tool export
- **Rule:** each tool file exports only its single `*Tool` entrypoint (inline handler + schema)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### DB access
- **Rule:** init once at startup (`initDb`); access via AsyncLocalStorage helpers — `withSystemDbContext(...)` for system ops, `withOrgDbContext(orgId, ...)` for tenant-scoped; do not pass DB via request context
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Query
- **Rule:** prefer Drizzle query API (`db.query.<table>.findMany/findFirst`); enforce org filtering in SQL, not runtime post-filtering
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### LangSmith integration
- **Rule:** mount LangGraph API in-process (no subprocess/proxy), gate with `ENABLE_LANGSMITH`, resolve graph specs from `./src/graphs/index.ts:{exportName}` (no generated `langgraph.json`)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Atlassian Forge install intent flow
- **Rule:** use org-scoped `POST /:orgSlug/api/v1/atlassian/installation` to set `forge_installations.status='pending'` + `installed_by_user_id`, enforce one pending per user via partial unique index, resolve webhook first by `cloud_id` then by installer-account join; keep UI status focused on `isLinked`/`isInstalled` and remove linked-site fields
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Atlassian multi-site ambiguity mitigation
- **Rule:** when Marketplace install can target different Confluence clouds under one Atlassian account, prefer explicit in-product/support documentation instructing admins to install on the intended cloud (URL `state` and post-event `accessible-resources` checks are insufficient here)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Atlassian Confluence config contract
- **Rule:** keep setup prerequisites and scope editing separate in UI, but persist both space scope and sync target through a single backend contract (`GET/POST /:orgSlug/api/v1/connectors/atlassian/config`); enqueue `confluence-sync-content` in OpenWorkflow after save and for Confluence webhooks (incremental mode).
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Notion database mirror contract
- **Rule:** mirror each selected Notion data source as a database folder containing `index.md`, a generated `table.csv` aggregate, and canonical per-row `rows/<row>/index.md` files. Keep row Markdown as the retrieval-friendly source of page properties and body content; treat CSV as a human-readable tabular companion.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Default LLM tiers
- **Rule:** unset `MODEL_*_NAME` defaults to `openai/gpt-5.6-terra` with `reasoning.effort=low|medium|high` (not Luna). Prefer Terra over Luna for repo-scale agent/ingestion work — Luna’s high/xhigh/max TTFT is too slow/risky for large-repo latency; Luna remains a cost option via explicit env override.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### `deduplicateAndStore` DB access
- **Rule:** never upsert objects/claims with one Postgres round-trip per extracted item. Prefetch by `deduplicationKey` / claim triples (chunked), merge in memory (`mergeRetrievalObjectPayloads` / logical evidence keys), batch writes; emit `codeIngestion.deduplicateAndStore.progress` + `flushWorkflowLog` on large runs. Keep stub-vs-full merge and duplicate-evidence→still-project semantics.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Ingestion project/embed/graph-sync
- **Rule:** do not issue one Falkor/embed/PG round-trip per claim or object. Project via grouped UNWIND MERGE chunks (fallback per-claim on batch failure); embed via `generateEmbeddings` + chunked updates; retraction graph effects via bulk retract/refresh/delete helpers. Emit progress + `flushWorkflowLog` on long steps.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Durable repository indexing
- **Rule:** durability belongs in OpenWorkflow step boundaries, not DIY codesearch/Postgres phase checkpoints. `repository-ingestion` runs child workflow `repository-index` (clone-checkout → zoekt non-fatal → detect-languages → `Promise.all` `scip:${lang}` non-fatal → merge-scip non-fatal). Zoekt or SCIP failure returns `searchIndexOk` / `scipIndexOk: false` and the parent marks `complete_with_issues` so extract can still run. Zoekt memory-fit failure skips SCIP langs. Codesearch exposes phase HTTP APIs with in-process spawn admission and same-repo purge exclusion (no begin/end lease). Step badge writes are monotonic. Extract is OW+ReAct (per-root `extract-kind` then `identify`, then dedup/project/embed) — keep LangGraph for conversation/Studio, not as the ingest durable orchestrator.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Repository indexing admission
- **Rule:** keep durability in OpenWorkflow step boundaries and memory admission at process boundaries; do not add cross-step HTTP/Postgres/Redis leases for codesearch indexing. Codesearch phase APIs run without a begin/end protocol; same-process repo index work may overlap, while purge takes a same-repo in-process exclusive operation so disk/shard removal does not race active phase work.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Ingestion Postgres pool hygiene
- **Rule:** do not wrap whole `deduplicateAndStore` in one `withOrgDbContext` / `withNodeOrgDbContext`. Use short per-chunk/per-phase txs. `setIngestionIndexingStep` must reuse `tryGetOrgDb()` when already in org context (parallel identify fan-out otherwise stamps out N pool checkouts). Treat Node `AggregateError` with nested `ETIMEDOUT` and pg `timeout exceeded when trying to connect` as transient in `isTransientDbConnectionError` (walk `AggregateError.errors`, not only `.cause`).
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Repository unindex/delete
- **Rule:** durable `repository-deletion` OpenWorkflow — never fire-and-forget cleanup on the API inside one long `withOrgDbContext`. Steps: `prepare-purge` (evidence + persist `graphEffects`) → `delete-row` → `sync-graph` → `purge-codesearch`. Graph/codesearch must run after the org PG txn commits. Codesearch service purge may run after the row is gone (`repoName` + JWT `sub=repo-purge:{repoId}`). Attempt-scoped idempotency (`…:{updatedAt}`) so UI “Retry unindexing” starts a new run. Log nested/`AggregateError` via `formatUnknownError`.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### `purgeRepositoryEvidencePg` must be set-based
- **Rule:** after chunked evidence delete, prefetch remaining evidence once, bulk-`DELETE` fully-owned claims + set-based orphan objects (`NOT EXISTS` claim refs). Only multi-source residuals get confidence updates. Do not per-claim `reconcileClaimAfterEvidenceChange` for repo purge (N+1; ~1s/claim on Neon). Partial-ingest path may still use per-claim reconcile.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Auth provider UI discovery
- **Rule:** `@daveyplate/better-auth-ui` shows available social providers from backend config; no manual UI updates when adding providers
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Auth secret
- **Rule:** no code-level default `AUTH_SECRET`; require explicit env, minimum 32 characters
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Better Auth trusted-origin
- **Rule:** when `AUTH_ALLOWED_ORIGINS` unset, restrict to strict same-origin from auth base URL; for `/.auth/*` resolve auth config by request origin for self-hosted deployments
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Better Auth schema ownership
- **Rule:** auth DB objects managed by Better Auth tooling; not hand-authored Drizzle schema in app
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Better Auth schema layout
- **Rule:** generated Drizzle exports in `apps/backend/src/db/schema/auth.ts`; compose in `schema.ts`, pass explicit `{ ...schema, ...relations }` to `drizzleAdapter(...)` for plural auth models
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Unified object ID
- **Rule:** `apps/backend/src/lib/id.ts` — uuid v7 + `@scure/base` base32nopad, `<prefix>_<base32(uuidv7-bytes)>`; Better Auth `advanced.database.generateId` delegates after model→type slug mapping
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Repository ID validation
- **Rule:** `repositoryIdSchema` accepts legacy `repo_[A-Z2-7]+` and new UUIDv7 base32hex `repo_[0-9a-v]+` for mixed records
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Tenant propagation
- **Rule:** backend signs short-lived HS256 bearer JWTs for codesearch; codesearch validates signature + issuer + audience, scopes repo access by `orgId` claim (no `MOCK_ORG_ID`)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Repository SQL safety
- **Rule:** never query repositories without tenant filter; models/tools include `orgId`; routes use only validated `c.get("orgId")` (no header fallback)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Agent tool tenancy
- **Rule:** LLM tool schemas must not accept `orgId`; tools get org from trusted Hono context via `getContext()` → `session.activeOrganizationId`, then apply SQL org filters
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Better Auth UI (apps/ui)
- **Rule:** public `/` lightweight; auth/account under `/.auth/*`; org settings under `/$organizationSlug/organization/$organizationView`; `@daveyplate/better-auth-ui` containers
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### UI icon assets
- **Rule:** `apps/ui/public/icons` — URL-safe lowercase kebab-case, size suffix `-<width>x<height>` before extension
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Generated app-icon
- **Rule:** variants in `apps/ui/public/icons` with kebab-case + size suffixes; favicon at root `apps/ui/public/favicon.ico`; `manifest.json` references root favicon and `icons/...` PNGs
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### TanStack devtools
- **Rule:** keep `devtools()` in `vite.config.ts` (strips from prod); gate `<TanStackDevtools />` in routes with `import.meta.env.DEV`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Favicon generation
- **Rule:** if `sips` fails for `.ico`, generate `apps/ui/public/favicon.ico` from 512 PNG via Python Pillow with embedded sizes (16/24/32/48/64)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### UI testing
- **Rule:** stories/tests collocated with code; no top-level `src/stories` or generic `src/test`; Vitest for non-visual logic; Storybook for component verification
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Biome (apps/ui)
- **Rule:** use root `biome.jsonc` (no nested `apps/ui/biome.json`); enable `css.parser.tailwindDirectives` at root for Tailwind at-rules
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Tailwind CSS in editor
- **Rule:** workspace `.vscode/settings.json` — `"css.lint.unknownAtRules": "ignore"` to silence VS Code warnings for Tailwind at-rules; Biome lint stays active
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### UI component file organization
- **Rule:** one component per file unless trivial sub-component colocated in same file
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### UI copy language
- **Rule:** use UK English spelling in user-facing UI copy, for example `organisation` rather than `organization`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### UI icon library
- **Rule:** use `@tabler/icons-react` (not lucide-react); map Tabler `Icon*` names semantically from prior Lucide glyphs; keep size/class/ARIA props
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### App shell layout
- **Rule:** authenticated org/settings inside `AppShell` (two-column flex; SideNav + main); unauthenticated `/.auth/*` outside shell
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Component API boundary
- **Rule:** do not expose internal state/persistence (e.g. localStorage keys) as public props for testing/story convenience; drive variations via interaction/wrappers
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Vite dev output
- **Rule:** during host dev, UI runs under Turbo; rely on the Vite terminal for warnings (no separate Compose UI service)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### React data fetching (apps/ui):
- **Rule:** Do **not** use `useEffect` for **data loading**. In general prefer **`useQuery`** from **TanStack Query** — especially when fetching from an **API or server**. In **rare** cases (e.g. configuration read directly from the **UI server runtime**), a **TanStack Router route loader** (optionally with **`createServerFn`**) is acceptable. `useEffect` is still for **non–data-loading** browser work (e.g. third-party SDK `init`, DOM subscriptions).
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Amplitude / product analytics:
- **Rule:** Self-hosters should **not** need to **rebuild** the UI image — set **runtime** env on the UI server. Resolve **`AMPLITUDE_API_KEY`** / **`AMPLITUDE_REGION`** in the **root route loader** via **`getAmplitudeRuntimeConfig()`** (server-side during SSR); pass config into the client as loader data — **no client `fetch`** for bootstrap. Same JSON shape is also served at **`GET /api/v1/c/s`** for operators. Point the Browser SDK **`serverUrl`** at a **same-origin proxy** (`/.amp/events`). **Single** project key for browser + backend MCP. **Page views:** SDK **autocapture** defaults. See ADR-017.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Unmatched-route fallback
- **Rule:** mount explicit backend routes first; final `app.all("*")` in `apps/backend/src/app/app.ts` proxies unknown paths to UI origin from `UI_PROXY_URL` via Hono `proxy()`. Auth middleware in `withAuth.ts`, applied in `src/routes/v1/index.ts` via `v1.use("*", withAuth)` (no path-prefix checks in global middleware)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### apps/ui
- **Rule:** Vitest + Testing Library for component tests, Storybook for exploration
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Backend and codesearch
- **Rule:** tests collocated under `src/` next to subjects (see Ingestion testing above)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Codesearch ingest memory gate
- **Rule:** after significant Zoekt/SCIP ingest changes, run `pnpm --filter @ctxpipe/codesearch test:manual:kubernetes-memory`; this expensive Kubernetes gate stays outside default tests and must pass without OOM/137 with non-empty SCIP artifacts. Calibrate its placeholder ceiling from VmHWM/cgroup peak plus 10-15% headroom (at most 512 MiB).
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Codesearch ingest OOM classification
- **Rule:** optional-index / memory-fit ingest changes must include automated child-137 HTTP classification (phase route + codesearch client rewrite, same split as Zoekt) plus the shared Docker `oom-simulation.sh` probe already in the default codesearch suite. After those PRs, run a Sol (`gpt-5.6-sol-high`) Standards + Spec adversarial review.
- **Category:** convention
- **Date:** 2026-08-19
- **Source:** user correction (SCIP optional ingest; mirror Zoekt mem-crash tests + Sol review)

### Stay on feature branch across planning sessions
- **Rule:** Do not create a new git branch unless HEAD is already on `main` (or the user explicitly asks). Continue multiple planning/implementation sessions on the current feature branch.
- **Category:** workflow
- **Date:** 2026-08-12
- **Source:** user correction

### Git sources vs GitHub picker
- **Rule:** the repositories page is an inventory of what is indexed (search, status, relative `lastIngestedAt`). Changing *which* GitHub App repos are ingested is the setup form. Do not mix connector types (docs/tools) onto Git sources. Picker save merges already-indexed URLs with the selected GitHub ids — never “whatever was visible”. Logic lives in `githubRepoSelection.ts`. Large-list UX is verified with Storybook + MSW (400-repo stories), not a DB/GitHub seed script.
- **Category:** pattern
- **Date:** 2026-08-13
- **Source:** repo-page-ux

### Git sources list virtualisation
- **Rule:** `/$orgSlug/repositories` uses `@tanstack/react-virtual` `useWindowVirtualizer` (`GitSourcesVirtualList`). Do not mount every `RepositoryCard`/React Aria menu. Row order is `buildGitSourceListRows` (pending then indexed). Scroll is still the document. Use a **fixed row size** — do not `measureElement`. While `isScrolling`, skip menus/tooltips and raise overscan. Hairline dividers (`border-white/[0.06]` / 1px repeating gradient), not a painted `gap`. Verify with **Pages / Repositories / Four Hundred Sources**.
- **Category:** pattern
- **Date:** 2026-08-13
- **Source:** repo-page-ux

### GitHub picker list virtualisation
- **Rule:** the setup form’s select-mode list is a nested `max-h-96` scroller (`GithubRepoPickerList` + `useVirtualizer`), not RAC `GridList`. Selection is a `Set` of GitHub ids; toggling one id must not rebuild from the visible slice. Verify with **Pages / Repositories / Four Hundred GitHub Picker**.
- **Category:** pattern
- **Date:** 2026-08-13
- **Source:** repo-page-ux

### Connector list accordion
- **Rule:** Connectors page rows share `ConnectorListItem`. Closed: icon, name, pulsing health (`connected` / `not yet connected` / `couldn't load` / `sync failed` / `config PR failed`), overflow menu, chevron. Open: Workspace, Scope, synchronised repository, text action link. Do not put setup steppers on the list — those belong in the wizard. Do not use a generic “Error” chip or orange alert icons; the chip names the cause. Display order is GitHub first (`sortOrgConnectionsForDisplay`). Linear “Manage scope” must open the scope editor (`manageScope`), same as Notion — not the “connected” splash.
- **Category:** pattern
- **Date:** 2026-08-13
- **Source:** repo-page-ux

### Connector setup wizards
- **Rule:** Linear, Notion, and Confluence share the same chrome: `ctx-node` mark in the header, semantic colour tokens, no nested zinc cards. Existing `rounded-none` on those wizards stays until a dedicated pass; **new or touched** chrome follows [apps/ui/DESIGN.md](../../apps/ui/DESIGN.md) (`rounded-lg` / `--radius`). Do not add more square overrides. Do not leave Atlassian/Confluence on `rounded-md` callback boxes or filled `bg-zinc-900` panels.
- **Category:** convention
- **Date:** 2026-08-13
- **Source:** repo-page-ux; updated 2026-08-15 for product-ui radius target

### Product UI skills vs marketing frontend-design
- **Rule:** Do not install Anthropic `frontend-design` (or similar marketing taste skills) as always-on for `apps/ui`. Use first-party [product-ui](../../.agents/skills/product-ui/SKILL.md) + [DESIGN.md](../../apps/ui/DESIGN.md). Do not paste copyrighted book prose or figures (including Refactoring UI) into skills or the repo; encode tactics as house yes/no rules in our own words.
- **Category:** convention
- **Date:** 2026-08-15
- **Source:** ui-design-skills research / product-ui skill

### Cursor Task models
- **Rule:** always pass an explicit Task `model` (see root [AGENTS.md](../../AGENTS.md) **Cursor Task models**). Implementation and explore: `cursor-grok-4.6-high-fast`. Review and grilling: `gpt-5.6-sol-high`. Map leftover Claude names: Sonnet/Fable/Haiku → Grok; Opus (including xhigh/fast) → `gpt-5.6-sol-high`. This is a parent-agent nudge; disabling Claude in Cursor Settings → Models is the hard block.
- **Category:** convention
- **Date:** 2026-08-17
- **Source:** user preference (Grok for implementations, Sol for reviews)

