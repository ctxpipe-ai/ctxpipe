# Lessons learned

Highest-priority confirmed rules for agents. Migrated from former `patterns.md` (ADR-024).

## Rules kept in agent instructions or ADRs

These lessons moved to the instructions that agents always read. Do not add them here again.

| Rule | Where it is now |
| --- | --- |
| Do not pull one-off values to globals; environment variables only for deployment or operator values | Root [AGENTS.md](../../AGENTS.md) Code style (details: Environment variables below) |
| US English and ASD-STE100; UI copy at about 80% strength | Root [AGENTS.md](../../AGENTS.md) Language |
| Stay on the current feature branch; sub-agent models; agent writing goes to `.ai/scratchpad/` or `.ai/memory/`, not root `docs/` | Root [AGENTS.md](../../AGENTS.md) Git branches, Sub-agent models, Public docs |
| `pnpm dev`, `pnpm dev:infra`, `pnpm start`, portless | Root [AGENTS.md](../../AGENTS.md) Local development |
| Tests fake the environment, not our modules; proof uses a real collaborator | Root [AGENTS.md](../../AGENTS.md) Testing and the [tdd skill](../../.agents/skills/tdd/SKILL.md) |
| Markdown-only memory with capture skills | [ADR-024](decisions/ADR-024-markdown-only-local-memory-capture.md) and root [AGENTS.md](../../AGENTS.md) Local agent memory |
| `@hono/zod-openapi` routes, `/:orgSlug/api/v1`, `/.docs/openapi`, `@hono/mcp`, collocated Zod schemas, transactions, `db:generate` migrations | [apps/backend/AGENTS.md](../../apps/backend/AGENTS.md) |
| Codesearch Kubernetes memory gate | [apps/codesearch/AGENTS.md](../../apps/codesearch/AGENTS.md) |
| `rounded-md`, React Aria first, CSS-first responsive layout, selected chrome on the click, no shell remount | [apps/ui/AGENTS.md](../../apps/ui/AGENTS.md) |
| Pierre for the Files pane | [ADR-040](decisions/ADR-040-pierre-files-pane-chrome.md) |
| RLS with the `ctxpipe_app` role | [ADR-042](decisions/ADR-042-postgres-rls-app-role.md) |

## Entries

### Environment variables
- **Rule:** Use an environment variable only for a value that **differs by deployment** (dev, staging, production) or that **operators or customers must supply** (secrets, base URLs, resource limits for their infrastructure). Do **not** use one to toggle a **product feature** or **internal logic or defaults**; keep those in code or committed config. A public value that is not a secret (for example a JWKS endpoint) is a constant in code, unless an operator or tenant must supply it.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (two entries)

### Biome
- **Rule:** Biome lints and formats the whole monorepo from the root `biome.jsonc` (no nested `apps/ui/biome.json`), with `css.parser.tailwindDirectives` on for Tailwind at-rules. The workspace `.vscode/settings.json` sets `"css.lint.unknownAtRules": "ignore"` only to silence the VS Code warning; Biome lint stays on.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (three entries)

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

### Changesets and releases
- **Rule:** PRs run `changeset status --since=origin/main` (release-bot PRs are skipped); it fails when a versionable workspace package changed without a changeset ([ADR-020](decisions/ADR-020-changeset-ci-guard-policy.md)). Authors and reviewers pick the package: `@ctxpipe/aws-cdk` for app or deploy work, otherwise the changed publishable package under `packages/*`. CI does not verify package names. Keep private runnable examples (for example `@ctxpipe/aws-cdk-self-host`) in `.changeset/config.json` `ignore`, so release PRs do not change their versions. Do not rely on release-bot commits to `main`: `@ctxpipe/aws-cdk` generates `src/pinned-service-image-tag.ts` at build and publish time, and the file stays untracked.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (three entries)

### Domain services
- **Rule:** shared between REST routes and MCP tools
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### IDs
- **Rule:** IDs are TEXT `<prefix>_<base32(uuidv7 bytes)>` (for example `repo_...`), made in `apps/backend/src/lib/id.ts` (uuid v7 and `@scure/base` base32nopad). Better Auth `advanced.database.generateId` delegates there after it maps the model to a type slug. `repositoryIdSchema` accepts the legacy `repo_[A-Z2-7]+` and the newer `repo_[0-9a-v]+` forms.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (three entries)

### Universal CLI UX
- **Rule:** publish the unscoped `ctxpipe` package from `packages/cli`; primary entry is **`npx ctxpipe`**; human path `npx ctxpipe init`; agent/CI uses explicit flags (`--org`, `--agents`/`--client`, `--scope`, `--non-interactive`, `--json`, `--base-url`, …). Setup auth prefers **OS keychain** via `@napi-rs/keyring`, with file fallback under `~/.config/ctxpipe/` when keyring is unavailable. Full flag list per command: `npx ctxpipe <cmd> --help` (commander.js).
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Memory hook candidates that are file-read telemetry
- **Rule:** Dismiss observe candidates whose excerpt is only `{file_path, content_length}` (or a glob/plan dump) of files already under `.ai/memory/` or `/opt/cursor/artifacts/plans/`. Those are Read-tool telemetry, not lessons. Do not copy them into `lessons-learned.md` or auto-write ADRs from hooks ([ADR-024](decisions/ADR-024-markdown-only-local-memory-capture.md)). Promote only user-confirmed facts via capture skills.
- **Category:** convention
- **Date:** 2026-08-19
- **Source:** PR #267 audit session (25 false-positive lesson candidates)

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

### `@ctxpipe/aws-cdk` self-host upgrades stay `cdk deploy`
- **Rule:** AWS self-hosters pick up construct-managed infra (new DB roles, secret rewrites, migrate-time provisioning) by bumping `@ctxpipe/aws-cdk` and running `cdk deploy`. Do not add `CtxPipe` props, a second connection string in the operator CDK app, or operator `psql` for work the construct can do. When that operator-visible behavior changes, update [`packages/aws-cdk/README.md`](../../packages/aws-cdk/README.md) and `apps/docs` self-hosting upgrade/AWS pages so the story remains bump-package-then-deploy.
- **Category:** convention
- **Date:** 2026-08-21
- **Source:** user requirement (RLS two-role split; candidate `2f0d95e99ba317d8`)

### `@ctxpipe/aws-cdk-self-host` CDK command orchestration
- **Rule:** define Turbo task `cdk:exec` with `dependsOn: ["^build"]` and wrap user-facing `pnpm cdk ...` to run through Turbo so workspace dependency `@ctxpipe/aws-cdk` is built automatically before synth/deploy/destroy flows.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### @hono/zod-openapi typing
- **Rule:** Do not override `createRoute` in app code. Fix typing in the dependency patch, with minimal const-generic and schema-inference relaxations that keep `c.req.valid("json")` typed. Keep request and response aligned: when you relax request-body typing, also relax the response `ExtractContent` (shared helper), or responses become `TypedResponse<never, ...>`. In declaration patches, do not index `Record<"schema", any>` (inference collapses to `any`); use `Record<"schema", infer Schema>` and infer input, output and content from `Schema`.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (three entries)

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

### New source connectors are git-native and follow Linear/Notion, not Confluence
- **Rule:** This is how to **build new control planes**; do not retrofit Linear, Notion, Slack or Confluence. Identity, encrypted secrets and repository binding live on `connections.config` jsonb ([ADR-018](decisions/ADR-018-unified-connections-table.md), [ADR-022](decisions/ADR-022-linear-connector-git-native-mirror.md), [ADR-023](decisions/ADR-023-notion-connector-git-native-mirror.md)). Do **not** copy Confluence's control plane (`*_sync_targets` tables, config-PR columns, channel or space catalogues in Postgres, dirty-entity flush tables); `confluence_sync_targets` stays as legacy Confluence only, and no new connector-specific tables. Connector **config** lives in `<slug>/config.yaml` and changes through a PR; **content** may commit to the target branch. Prefer Markdown. A connector that is thinner than a git-native mirror (for example Slack intent capture) stays thinner: omit `pendingConfig*`, `*/config.yaml` and config-push remirror unless the product has a reviewed scope file. Hosted and self-host run the same code; self-host traffic never goes through ctxpipe SaaS (no proxy, relay, gateway or hosted OAuth app). Process: [source-connectors skill](../../.agents/skills/source-connectors/SKILL.md).
- **Category:** convention
- **Date:** 2026-08-19
- **Source:** user direction after Linear, Notion, and Slack (PR #267); user correction during Slack `slack_sync_targets` unification (PR #267)

### Connector assets are durable git files
- **Rule:** Across existing and new source connectors, copy provider-declared file attachments and explicit embedded external media into deterministic git paths and rewrite Markdown to relative links ([ADR-028](decisions/ADR-028-git-native-connector-assets.md)). Ordinary hyperlinks and link-only attachment records stay links; Linear GitHub PR/commit references remain reference-only. Use the shared connector asset boundary: HTTPS + DNS-pinned public addresses for external media, provider credentials only on trusted hosts and stripped on cross-host redirects, 25 MiB per asset / 100 MiB per entity, safe fallback stubs, binary git-SHA no-op checks, and stale-asset pruning.
- **Category:** convention
- **Date:** 2026-08-21
- **Source:** user-confirmed cross-connector image/file capture policy

### Scoped-mirror rebound with matching config.yaml starts content sync
- **Rule:** After context-repo delete/recreate or rebind, a `draft` binding whose `<slug>/config.yaml` already matches the selected scope must start `initial_sync` (no config PR, `configPrEnqueued: false`, UI honours that). A matching live scope stays a no-op. Applies to Linear, Notion, PagerDuty, and Confluence (Confluence also starts content from the config workflow when yaml is unchanged). Slack has no yaml PR. Ingest after a connector git write goes through `runConnectorRepositoryIngestionWorkflow` (that helper owns logger context).
- **Category:** convention
- **Date:** 2026-09-22
- **Source:** production Linear stall after ctxpipe-context recreate; copied to sibling scoped mirrors

### Connector product vs self-host docs
- **Rule:** scoped-mirror connectors (Linear, Notion) need a **hosted product page** under `apps/docs/content/docs/(guide)/connections/source-connectors/<slug>.mdx` and a **self-host operator page** under `apps/docs/content/docs/self-hosting/<slug>.mdx`. Use Linear's hosted page as the structural template (managed-app callout, config-in-git, setup steps, layout, webhooks, troubleshooting). Copy Linear's headings, not Linear's provider-specific content. The hosted page describes user setup; it does not document creating the provider OAuth app — that stays on the self-host page, with a User guide pointer back. Add the slug to `source-connectors/meta.json` and cross-link connected-sources / context-repository.
- **Category:** convention
- **Date:** 2026-08-20
- **Source:** notion-docs branch; Linear hosted guide as template

### Agent tools
- **Rule:** Put only agent-callable tools in `src/tools`; shared helpers go in `src/lib` (or similar), and graph-specific instructions and nodes in `src/graphs/<graphName>/`. Each tool file exports only its single `*Tool` entry point (inline handler and schema). Serialize structured tool output to TOON before it goes to the LLM, to use fewer tokens.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (four entries)

### Org SQL is a short transaction; no SQL across I/O
- **Rule:** Call `initDb` once at startup and get the database through the AsyncLocalStorage helpers; do not pass it through request context. Tenant SQL goes through `withOrgDbContext` / `orgSql` / `getOrgDb()`: a short `BEGIN` + `SET LOCAL app.organization_id` + `COMMIT` on the transaction-mode pooler, which is the RLS hook. A nested same-org call reuses the open transaction; a nested call for another org, or with its own idle timeout, throws; an inner throw aborts the outer transaction (no savepoints) ([ADR-041](decisions/ADR-041-short-org-sql-unique-sandbox-rows.md), [ADR-042](decisions/ADR-042-postgres-rls-app-role.md)). `withSystemDbContext` / `getSystemDb()` is only for Better Auth tables, `organizations`, `members`, `invitations` and `connection_directory`. Never query tenant rows without an org filter in SQL (no post-filtering at runtime); routes use only the validated `c.get("orgId")`, with no header fallback. Prefer the Drizzle query API. Request middleware (`withNetworkOrgContext`) puts only the org id in AsyncLocalStorage; it opens no transaction. No SQL connection or transaction spans GitHub, sandbox provider, codesearch, FalkorDB, connector HTTP, model or embedding calls, or `enqueueWorkspace*`; those gateways call `assertNotInOrgDbContext()`. Two incidents show why: a polled connector status endpoint that called GitHub inside the request transaction left idle transactions, the pool timed out, and auth, MCP and connectors queued for 30–120 s; and `ctx_advisor` held a transaction across a 48–60 s model run until Postgres killed it (`Connection terminated unexpectedly`). Treat that error as a transaction-scope bug and do not swallow it. Status reads use stored or bounded-cache state, provider calls have short timeouts, and stable screens do not poll every few seconds. Do not `SET SESSION` on the pooled URL, hold a `PoolClient` until the response, add `connect()` retries, use session advisory locks or add a second lock pool; sandbox ownership is an expiring owner-token row.
- **Category:** convention
- **Date:** 2026-08-31
- **Source:** migrated from patterns.md (DB access, Query, Repository SQL safety); user correction (RLS is a hard requirement; lock pool caused DELETE 500; ADR-042 enablement); production Railway incident diagnosis (GitHub quota exhaustion, idle transaction termination, pg-pool acquisition timeouts); PR-304 preview black-box `ctx_advisor` tools/call on a newly created empty org

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
- **Rule:** mirror each selected Notion data source as a database folder containing `index.md`, a generated `table.csv` aggregate, and canonical per-row `rows/<row>/index.md` files with row-local `assets/` ([ADR-028](decisions/ADR-028-git-native-connector-assets.md)). Keep row Markdown as the retrieval-friendly source of page properties, body content, and relative asset links; treat CSV as a human-readable tabular companion.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Default LLM tiers
- **Rule:** unset `MODEL_*_NAME` defaults are fast `openai/gpt-6-luna?reasoning.effort=high`, medium `openai/gpt-6-luna?reasoning.effort=xhigh`, and high `xiaomi/mimo-v2.6-pro`. The fast tier is the low slot. Do not revert these to GPT-5.6 Terra.
- **Category:** convention
- **Date:** 2026-09-28
- **Source:** product default model update

### Ingestion does not round-trip per item
- **Rule:** Do not issue one Postgres, FalkorDB or embedding round trip per extracted item, claim or object. Prefetch by deduplication key or claim triple in chunks, merge in memory, and write in batches. Project with grouped `UNWIND MERGE` chunks (fall back to one claim at a time only when a batch fails), embed with `generateEmbeddings` and chunked updates, and apply retraction graph effects with bulk helpers. Long steps emit progress and `flushWorkflowLog`.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (two entries)

### Durable repository indexing and admission
- **Rule:** Durability belongs in OpenWorkflow step boundaries, and memory admission at process boundaries; do not add DIY codesearch or Postgres phase checkpoints or cross-step HTTP, Postgres or Redis leases. `repository-ingestion` runs the child workflow `repository-index` (clone-checkout, Zoekt (not fatal), detect-languages, `scip:${lang}` in parallel, merge-scip). A Zoekt failure returns `searchIndexOk: false`, and the parent marks `complete_with_issues` so extraction still runs. Codesearch phase APIs have no begin/end protocol: the in-process pipeline map stays across phases and is dropped on `merge-scip` or a fatal clone or detect response (an idle TTL reclaims abandoned holds). Overflow sleeps 30 s until a slot opens; do not escalate backoff or thread Retry-After, because this is a queue. Same-process index work may overlap, while purge takes a same-repository exclusive operation. Step badge writes are monotonic. Do not bump `repositories.updatedAt` as a heartbeat. After OpenWorkflow retries a crashed step, mark the run `failed`; do not reclaim `queued` or `running` by age. Extraction is OpenWorkflow plus ReAct (per root `extract-kind`, then `identify`); LangGraph is only for extraction agents, not the durable orchestrator.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (two entries)

### Ingestion Postgres pool hygiene
- **Rule:** do not wrap a whole ingestion phase in one `withOrgDbContext`. Use short transactions per chunk or per phase. `setIngestionIndexingStep` must reuse `tryGetOrgDb()` when already in org context (parallel identify fan-out otherwise stamps out N pool checkouts). Treat Node `AggregateError` with nested `ETIMEDOUT` and pg `timeout exceeded when trying to connect` as transient in `isTransientDbConnectionError` (walk `AggregateError.errors`, not only `.cause`).
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

### Better Auth UI (apps/ui)
- **Rule:** Public `/` stays light; auth and account pages are under `/.auth/*`; org settings are under `/$organizationSlug/organization/$organizationView`; use the `@daveyplate/better-auth-ui` containers. They show the social providers from the backend config, so a new provider needs no UI change.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (two entries)

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

### Better Auth schema
- **Rule:** Better Auth tooling manages the auth database objects; do not hand-write them as Drizzle schema. The generated Drizzle exports are in `apps/backend/src/db/schema/auth.ts`; compose them in `schema.ts` and pass `{ ...schema, ...relations }` to `drizzleAdapter(...)` for plural auth models.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (two entries)

### Tenant propagation
- **Rule:** backend signs short-lived HS256 bearer JWTs for codesearch; codesearch validates signature + issuer + audience, scopes repo access by `orgId` claim (no `MOCK_ORG_ID`)
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Agent tool tenancy
- **Rule:** LLM tool schemas must not accept `orgId`; tools get org from trusted Hono context via `getContext()` → `session.activeOrganizationId`, then apply SQL org filters
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### UI icons and favicon
- **Rule:** Icon files in `apps/ui/public/icons` are URL-safe lowercase kebab-case with a `-<width>x<height>` suffix before the extension. The favicon is `apps/ui/public/favicon.ico`; `manifest.json` refers to it and to the `icons/...` PNGs. If `sips` cannot make the `.ico`, generate it from the 512 PNG with Python Pillow, with sizes 16/24/32/48/64.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (three entries)

### TanStack devtools
- **Rule:** keep `devtools()` in `vite.config.ts` (strips from prod); gate `<TanStackDevtools />` in routes with `import.meta.env.DEV`
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### Test placement
- **Rule:** Tests and stories are next to the code they test, under `src/`; there is no top-level `src/stories` or generic `src/test`. In `apps/ui`, use Vitest and Testing Library for logic and component tests, and Storybook for visual checks and exploration.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md (three entries)

### UI component file organization
- **Rule:** one component per file unless trivial sub-component colocated in same file
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

### Browser OTEL / HyperDX:
- **Rule:** Self-hosters set runtime env on the UI server and do not rebuild the UI image for telemetry. Config is resolved in the root route loader. The browser posts only to same-origin `/.otel`. The UI server holds the collector URL and ingest key. See ADR-038 (supersedes ADR-017).
- **Category:** convention
- **Date:** 2026-09-26
- **Source:** PR-343: Amplitude replaced by HyperDX RUM

### Unmatched-route fallback
- **Rule:** mount explicit backend routes first. `registerUiRoutes` (`apps/backend/src/routes/ui.ts`), called last in `app.ts`, adds the final `app.all("*")` that proxies unknown paths to `UI_PROXY_URL` with Hono `proxy()`; it aborts after `UI_PROXY_TIMEOUT_MS` (15 s) and returns 504. The auth middleware is in `withAuth.ts` (`withCookieAuth`, `withBearerAuth`, `requireAuth`, `withNetworkOrgContext`) and is applied with `.use("*", …)` in `src/routes/v1/index.ts`. Global middleware does no path-prefix checks.
- **Category:** convention
- **Date:** 2026-08-11
- **Source:** migrated from patterns.md

### GitHub install leads to a Workspace destination
- **Rule:** The GitHub App install grants **access** only. After install, tell the user the connection is complete, then offer: create a Workspace, add repositories to an existing one (listed), or close the wizard. Do **not** explain that the connection is organization-wide or that repositories are linked per Workspace, and do not show an org-wide ingest picker. Repositories are linked from Workspace Settings. The repository picker list (`GithubRepoPickerList`) is a nested `max-h-96` scroller with `useVirtualizer`, not RAC `GridList`; selection is a `Set` of GitHub ids, and a toggle must not rebuild it from the visible slice. Verify large lists with Storybook and MSW, not with a database or GitHub seed script.
- **Category:** product
- **Date:** 2026-08-22
- **Source:** repo-page-ux (2026-08-13); user correction (GitHub workspace destination, candidate `ba616391f38e94cf`)

### Connector list accordion
- **Rule:** Connectors page rows share `ConnectorListItem`. Closed: icon, name, pulsing health (`connected` / `not yet connected` / `couldn't load` / `sync failed` / `config PR failed`), overflow menu, chevron. Open: Workspace, Scope, synchronised repository, text action link. Do not put setup steppers on the list — those belong in the wizard. Do not use a generic “Error” chip or orange alert icons; the chip names the cause. Display order is GitHub first (`sortOrgConnectionsForDisplay`). Linear “Manage scope” must open the scope editor (`manageScope`), same as Notion — not the “connected” splash.
- **Category:** pattern
- **Date:** 2026-08-13
- **Source:** repo-page-ux

### Connector setup wizards
- **Rule:** Linear, Notion, and Confluence share the same chrome: `ctx-node` mark in the header, semantic colour tokens, no nested zinc cards. Existing `rounded-none` on those wizards stays until a dedicated pass; **new or touched** chrome follows [apps/ui/DESIGN.md](../../apps/ui/DESIGN.md) (`rounded-md`). Do not add more square overrides. Do not leave Atlassian/Confluence on leftover `rounded-lg` callback boxes or filled `bg-zinc-900` panels.
- **Category:** convention
- **Date:** 2026-08-13
- **Source:** repo-page-ux; radius follows [apps/ui/AGENTS.md](../../apps/ui/AGENTS.md) (`rounded-md`, 2026-10-01)

### Product UI skills vs marketing frontend-design
- **Rule:** Do not install Anthropic `frontend-design` (or similar marketing taste skills) as always-on for `apps/ui`. Use first-party [product-ui](../../.agents/skills/product-ui/SKILL.md) + [DESIGN.md](../../apps/ui/DESIGN.md). Do not paste copyrighted book prose or figures (including Refactoring UI) into skills or the repo; encode tactics as house yes/no rules in our own words.
- **Category:** convention
- **Date:** 2026-08-15
- **Source:** ui-design-skills research / product-ui skill

### Scope shared UI class helpers
- **Rule:** when iterating on one region of a surface (footer vs list, one panel vs another), do **not** put hover/focus/outline experiments on shared class helpers that restyle siblings. Keep shared layout tokens shared; keep region-only treatments on region helpers.
- **Category:** convention
- **Date:** 2026-08-18
- **Source:** SideNav polish session (generalized)

### Focus and hover rings
- **Rule:** The keyboard focus ring is `outline-2` / `outline-offset-1` / `outline-teal-400/60`, with `focus-visible:relative focus-visible:z-10` so it is above neighbors. Tokens: [`apps/ui/src/lib/focus-styles.ts`](../../apps/ui/src/lib/focus-styles.ts) (`focusVisibleClassName`, `focusVisibleRingClassName`, RAC `focusRing`). Do not use `outline-none` where you need a ring: it sets `outline-style: none`, so later outline color utilities paint nothing. Use `outline-solid outline-0` (or a transparent width that is always on) and change only the color on `hover` / `focus-visible`; an outline that appears only on hover flashes a bright default ring. Soft hover washes stay separate and must survive the focus style. At edges, trade padding for equal margin so the ring stays in the viewport; do not let a parent `overflow-hidden` clip rings (clip labels locally). A nested focusable has the same radius as the painted hit target. A resize splitter has no focus box: it uses the same line as hover, and arrow keys move it.
- **Category:** pattern
- **Date:** 2026-08-18
- **Source:** SideNav polish session (generalized; two entries)

### Do not squash migrations already applied to PR Neon
- **Rule:** PR preview DBs are reused (`preview/pr-N` from production, not reset each deploy). Deleting applied Drizzle folders and regenerating the same DDL under a new tag re-runs `CREATE UNIQUE INDEX` and fails with `42P07`. Keep the original folders, or make the replacement DDL idempotent (`IF NOT EXISTS`) like `clean_lyja` / `smart_nextwave`. Never squash unreleased history that a long-lived PR branch may already have applied.
- **Category:** convention
- **Date:** 2026-08-19
- **Source:** slack-connector PR deploy (`connections_slack_team_id_uq` already exists)

### Slack Events API bot green-dot is an app-settings toggle
- **Rule:** HTTP Events API bots are grey until **Always Show My Bot as Online** is on in [api.slack.com/apps](https://api.slack.com/apps) → **App Home** / **Bot Users** (Marketplace apps: Live App Settings). Slack then sets `always_active: true`; clients show a green dot even though `presence` stays `away`. `users.setPresence` cannot force a bot online. Socket Mode does **not** restore RTM-style connected=green and is the wrong production delivery path (Marketplace requires HTTP). Leave Socket Mode **off** for ctxpipe (`POST /api/v1/webhook/slack`). The toggle is a liveness lie — same one Claude/Cursor use — not a second event-delivery protocol.
- **Category:** convention
- **Date:** 2026-08-20
- **Source:** user feedback after first successful Slack capture (PR-267); Slack [presence docs](https://docs.slack.dev/apis/web-api/user-presence-and-status) Events API bots section

### Slack Events ACK first; the first status is the worker
- **Rule:** After signature, event-shape and live-target checks, return HTTP 200 to Slack before you await OpenWorkflow or Postgres. An awaited enqueue can pass Slack's deadline of about three seconds and cause 499 retries; on PR previews each retry can wake and replace a booting worker. Enqueue asynchronously, publish a terminal status when the enqueue fails, and debounce worker wakes past the retry burst. **ctx| agent working…** comes from `slack-mention-agent`, not from the webhook, so on a sleeping PR worker the first status takes 10–20 s of boot (a warm worker takes about 1–3 s). Do not diagnose that delay as slow Slack Events. For a faster first status, post it from the webhook (the bot token is on that request) and let the job `chat.update` it.
- **Category:** workflow
- **Date:** 2026-08-20
- **Source:** slack-connector PR-267 live diagnosis (499 webhook retries and three replacing worker deploys); user feedback after first successful Slack capture (PR-267)

### Proof of a Slack capture
- **Rule:** The Event Subscriptions Request URL is one setting for the whole Slack app, not one per install, so OAuth can succeed against a PR `AUTH_BASE_URL` while `app_mention` still goes to production (or nowhere). To test on a PR environment, point the URL at that environment's `/api/v1/webhook/slack` and mention the bot through autocomplete. `POST /api/v1/webhook/slack` returns 200 for skipped events, a dead worker and a good enqueue, and `GET …/connectors` 200 or `status === installed` only means Postgres has an installed row and a bound repository. A working capture shows all three: a **new** webhook POST after the mention, **ctx| agent working…** in the thread, and a git commit under `slack/`. After a reconnect, no new webhook means the message was not an `app_mention`. `chat.postMessage` swallows `not_in_channel`, so you get silence, not an error.
- **Category:** workflow
- **Date:** 2026-08-19
- **Source:** slack-connector live test (PR-267; zero webhook logs on mention); slack-connector PR-267 live debug (no webhook after the rebind)

### Railway PR preview UI is not production’s UI
- **Rule:** Duplicate-from-production copies `UI_PROXY_URL` as `${{ui.RAILWAY_PRIVATE_DOMAIN}}`. That private hostname can still reach the warm production UI, so `https://backend-pr-N.up.railway.app` serves main even when Railway reports the PR UI image SUCCESS. Pin backend `UI_PROXY_URL` to a PR-specific public UI domain (`ui-pr-N.up.railway.app`). Smoke-test by comparing the proxied `/assets/main-*.js` hash to `app.ctxpipe.ai` (identical hash = production leak) and grepping the **JS bundle** for a branch-only route (`ws/$workspaceSlug` / `_orgSlug.ws._workspaceSlug`, fixed-string `grep -Fq` in single quotes under `set -u`). Do **not** grep `/` HTML — TanStack SSR of `/` only serializes matched routes, so a correct PR UI fails that canary too. Separately: production Terraform `railway_service.source_image` is service-global; provider `Update()` runs `serviceConnect` + `redeployAllInstances` and overwrites every `pr-*` instance. Ignore `source_image` after create; roll images with environment-scoped GraphQL (`serviceInstanceUpdate` on production or `pr-N` only), then assert each `pr-*` ui/backend `source.image` is still `pr-N-*` (fail if it equals this production SHA or `latest`). Cursor Agent pushes often skip `pull_request` `synchronize`; PR Deploy and CI also run on `push` to the PR branch. **Do not `cancel-in-progress` PR Deploy** — cancelling the GH job leaves Railway still DEPLOYING; the next run times out on leftover rolls and never reaches the UI canary. Cancelled Actions ≠ cancelled Railway. Do not wrap the whole GraphQL deploy script in `nick-fields/retry` (that stacks a second `serviceInstanceDeployV2` on a still-DEPLOYING instance); retry GraphQL HTTP only; stop in-flight deployments before a new roll; treat serverless `SLEEPING` as success. Railway canvas image tags and Terraform plans for production `source_image` are not the preview. UI Nitro SSR must use runtime `AUTH_BASE_URL` (the preview backend origin), not Docker-baked `VITE_PUBLIC_API_URL=http://localhost:3000`.
- **Category:** workflow
- **Date:** 2026-08-22
- **Source:** PR-280 served `main-D0MgC9_q.js` (same as app.ctxpipe.ai) after a streak of cancelled PR Deploys + production Deploy; HTML `ws/$workspaceSlug` canary cannot see the JS route tree

### PR preview services sleep; check that first
- **Rule:** On Railway `pr-N`, codesearch often sleeps minutes after boot, and GitHub ingest then fails (connection refused, job killed). The worker idle-exits after `OPENWORKFLOW_IDLE_EXIT_SECONDS` (180 on previews) with a clean shutdown, so `environment_status` still shows SUCCESS; proof of a restart is a **new deploy timestamp**. The backend wakes the worker with `serviceInstanceDeployV2` after an enqueue (`railway-wake.ts`); no new worker deploy means the job did not run. A sleeping backend can take about 12 s to accept a Slack event, which is past Slack's deadline, so wake the backend and the worker **before** you mention the bot. `worker-supervisor.ts` decides idle from `workflow_runs` / `step_attempts` in the worker's own OpenWorkflow namespace (`preview-pr-N`, through `openWorkflowNamespaceId`); a query pinned to `default` sees an idle system during ingests, and nothing wakes the worker again. When a preview looks paused, look for runs with `available_at` in the past and `worker_id` null before you suspect codesearch or FalkorDB. Do not call a failed status a connector bug before you check sleep.
- **Category:** workflow
- **Date:** 2026-09-17
- **Source:** slack-connector PR-267 (codesearch stopped; worker idle-exit with no wake deploy); preview idle-exit while `repository-ingestion` runs sat unclaimed in a non-default namespace

### Slack channel-top-level mention is not a channel capture
- **Rule:** Capture requires `event.thread_ts` (a mention **inside** an existing thread). A channel-top-level `@bot capture` has no `thread_ts`; do **not** collapse to mention `ts` and snapshot the invocation. The webhook posts a refusal in-thread and does not enqueue `slack-mention-agent`. Mentioning on the channel-visible parent of a thread is the same signal (Slack omits `thread_ts`); tell the user to reply in the thread. Do not treat a success status on a channel-top-level mention as proof of engineering context.
- **Category:** workflow
- **Date:** 2026-08-20
- **Source:** user correction after `@ctxpipe-dev capture` in-channel (PR-267); git wrote the invocation, not the discussion

### GitHub App credential precedence and PEM validation
- **Rule:** GitHub writes resolve complete encrypted credentials from the selected `connections.config` **before** falling back to `GITHUB_PRIVATE_KEY`. Changing the worker environment does not repair a malformed `privateKeyEnc`; the backfill intentionally only fills rows where it is absent. Validate both the environment key and the decrypted per-connection key with `crypto.createPrivateKey()` without printing either secret. Repair an existing bad row through explicit credential rotation, not a blanket backfill.
- **Category:** convention
- **Date:** 2026-08-19
- **Source:** slack-connector PR-267 live diagnosis (`SlackTest` environment PEM valid; stored connection PEM failed with `ERR_OSSL_NO_START_LINE`)

### Claude Code Stop hooks cannot use additionalContext
- **Rule:** Emit top-level `decision: "block"` + `reason` on Claude Code Stop (same as Codex). Do **not** emit `hookSpecificOutput.additionalContext` on Stop: older CLIs and stale long-lived sessions reject the whole object (non-blocking → turn ends). Fresh 2.1.163+ accepts `additionalContext`, but the portable contract must not require it. Claude capture is **UserPromptSubmit + Stop** only — do not install `PostToolUse` observe (tool dumps become fake lessons). Stop continuation is **one-shot**: already-surfaced ids must not `decision: block` again on later turns.
- **Category:** convention
- **Date:** 2026-08-31
- **Source:** Claude Code 2.1.251 Stop hook validation failure after `npx ctxpipe init`; [anthropics/claude-code#50682](https://github.com/anthropics/claude-code/issues/50682)

### ctxpipe-observability stays in us-east4-eqdc4a
- **Rule:** Hosted observability uses the same Railway metal as product: `us-east4-eqdc4a` (Virginia, next to Neon `aws-us-east-1`). Pin with `RAILWAY_SERVICE_SET=observability scripts/railway-set-regions.sh`. The pin is unfinished while any service or volume still shows `asia-southeast1-eqsg3a`.
- **Category:** convention
- **Date:** 2026-09-25
- **Source:** user correction on PR-343 (stack landed in Singapore again after image-service create / region pin)

### Distributed OAuth connectors require a clean external-workspace acceptance test
- **Rule:** Never treat a provider workspace that already hosts the development app as proof that a new customer installation works. OAuth grants can be workspace-specific, additive, and contaminated by dashboard installs or earlier re-authorisations; Slack can also silently suppress Events API delivery when the installed token lacks an event scope. Before shipping a distributed connector, install it through the product OAuth flow into a fresh second workspace, inspect the returned and live token scopes, exercise the real webhook-to-durable-output path, and test re-authorisation after a required scope changes. Keep provider app configuration in a committed manifest and CI-check its scopes against the backend request.
- **Category:** testing
- **Date:** 2026-08-21
- **Source:** user-confirmed Slack connector production incident (ctxpipe workspace passed because its historical grant masked the fresh Tru Rec installation path)

### Workspace add is + from GitHub, uniqueness only
- **Rule:** Creating a Workspace is click **+** → pick a GitHub repo → go. The only extra check is whether a Workspace already uses that repo as its workspace repository (return the existing row). Do **not** auto-create Workspaces from Linear/Notion/Confluence/Slack dests at runtime. Existing dest Workspaces are a one-shot SQL migrate. Do not add sourcing-repo, unbind-first, or identity-FK special cases to that flow.
- **Category:** product
- **Date:** 2026-08-20
- **Source:** user correction (git-backed workspaces add flow)

### Product row backfills are SQL, not OpenWorkflow enqueue
- **Rule:** Do not copy `t08_enqueue_scip_migration_workflows` (`INSERT INTO openworkflow.workflow_runs`) for product data backfills. That migration existed to reindex every repo. Dest Workspace create/link is `INSERT` into `workspaces` / `workspace_linked_repositories` only — no job start from `db:migrate`.
- **Category:** convention
- **Date:** 2026-08-20
- **Source:** user correction (git-backed workspaces dest backfill)

### Region loading is a skeleton; process loading is the teal bar
- **Rule:** A wait whose populated UI is a list, tree, thread, or pane uses `Skeleton` / `SkeletonRow` that matches those rows — not `"Loading…"` and not a centered spinner. Long jobs or unknown structure (hydrate, OAuth wait, discovery) use `InlineLoader` / `ProgressLoader`. Button mutations use `isPending`. In-progress status on a known entity is a pulse-dot plus the word. Every fetch surface ships a `Loading` (or `Checking` / `Hydrating`) story with `delay("infinite")`.
- **Category:** convention
- **Date:** 2026-08-21
- **Source:** skeleton loading backfill (Operate UI audit)

### Product HTTP goes through the UI API gateway
- **Rule:** Every product HTTP call in `apps/ui` goes through `apiFetch` / `readApiJson` (`apps/ui/src/lib/api-result.ts`). Bare `fetch` + `if (!res.ok) throw` is a bug. Hono clients (`getApiClient`, `client`) and `auth-ssr` use `apiFetch`. `readApiJson` treats listed `emptyOn` statuses (409/404 only where that is already the contract) as data; every other `!ok` is `ApiError` with `status`. QueryClient default `retry` is `retryQuery`: at most one retry, only for `status === 0` or `>= 500` — never 4xx. Every `refetchInterval` uses `pollWhileOk` (or equivalent: stop on error). Loaders/`beforeLoad` may `await` only queries required to choose the route; landing-region warmup only when that region can succeed. The backend UI proxy aborts at 15s and returns 504. No env flag for these timeouts.
- **Category:** convention
- **Date:** 2026-08-22
- **Source:** workspace document-path 502 (files/tree 409 retried on SSR; connectors status 500 polled)

### Prefer named Tailwind utilities over arbitrary values
- **Rule:** Use the Tailwind scale (`tracking-tighter`, `p-2`, `text-sm`, `gap-3`). Write `tracking-[-0.5px]`, `text-[15px]`, or `p-[13px]` only when no named token is close.
- **Category:** convention
- **Date:** 2026-08-21
- **Source:** user correction (Workspaces nav label tracking)

### Workspace OpenCode chat uses the configured proxy, not native provider keys
- **Rule:** OpenCode ignores `MODEL_PROVIDER_*`. Do not remap `MODEL_PROVIDER_API_KEY` to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`. Chat uses only `MODEL_FAST_NAME` / `MODEL_MEDIUM_NAME` / `MODEL_HIGH_NAME` (default **fast**) through the app's OpenAI-compatible model proxy (`workspace-chat-model-proxy.ts`). Pin one `opencode-ai` version everywhere: today `1.18.34` in `WORKSPACE_CHAT_OPENCODE_CLI`, `apps/backend/Dockerfile`, `scripts/chat-sandbox/Dockerfile` and `ci.yaml`. When TanStack tools exist, the adapter overwrites `OPENCODE_CONFIG_CONTENT` — ship config as `opencode.json` plus `OPENCODE_CONFIG` via `createSecrets`. Model ids containing `gpt-5` still post `/v1/chat/completions` and require `chat.completion.chunk` SSE. Sandbox providers are in [ADR-048](decisions/ADR-048-native-postgres-sandbox-ownership.md); unsandboxed is never chosen automatically.
- **Category:** convention
- **Date:** 2026-08-22
- **Source:** OpenCode chatStream 500 (H1: Claude fallback + empty Anthropic credentials)

### Workspace chat streams first, reuses its sandbox, and stays stock
- **Rule:** Product Workspace chat is TanStack AI end to end (`@tanstack/ai-react` `useChat`, the official `webSocket()` / `toWebSocketStream`, and `chat()`). Use the latest `@tanstack/ai` (caret range, not an exact pin) unless there is a strong reason; helper drift is not one. Keep `@tanstack/ai*` stock: the only accepted patch is the one [ADR-044](decisions/ADR-044-workspace-chat-stock-tanstack.md) lists, and ServeError, echo or a failed resume are fixed in our wiring. Open the live connection and emit `RUN_STARTED` before GitHub, sandbox or OpenCode work. Persist the user turn and `lastMessageAt` on accept, so SideNav lists the row before `RUN_FINISHED`. Conversation SSR awaits only Workspace identity and stored turns, never files, git, graph or OpenCode; do not raise the 15 s UI proxy limit. Reuse one sandbox and workdir per conversation (`reuse: "thread"`); do not reclone every turn. Many conversations run at once, so do not serialize the host on one OpenCode port or a process-wide mutex. Do not put an example question (such as "what's in this repo?") or a precomputed inventory into the prompt; get latency from a warm sandbox ([workspace-chat-latency](PRDs/workspace-chat-latency.md), [workspace-chat-sandboxes](PRDs/workspace-chat-sandboxes.md)).
- **Category:** convention
- **Date:** 2026-08-24
- **Source:** workspace chat TTFB ~20s; user correction to un-pin and use official WebSockets; user correction (PR-280 ServeError / turn latency; candidates `34215a9a726b6c6d`, `6591dda6936d90c4`); user correction (workspace-chat latency)

### Workspace owners
- **Rule:** Native git owns repository, revision, branch, diff and worktree. OpenWorkflow owns durable jobs: each typed write is a native workflow with explicit steps, retries, waits and resume, and `workspace_write_jobs` only stores bound command and result metadata ([ADR-047](decisions/ADR-047-native-durable-write-workflows.md)). Stock TanStack AI owns chat, persistence, the stream lifecycle and the OpenCode sandbox ([ADR-044](decisions/ADR-044-workspace-chat-stock-tanstack.md), [ADR-048](decisions/ADR-048-native-postgres-sandbox-ownership.md)). Pierre (`@pierre/trees`, `@pierre/diffs`) owns the Files tree and diff and editor chrome; it is chrome only, and the pane shows the full Workspace repository ([ADR-040](decisions/ADR-040-pierre-files-pane-chrome.md)). ctxpipe code owns organization authorization, Workspace identity, projection activation, credential brokering and publish rules. Do not add a second chat engine, write runner or scheduler, or a homemade file explorer, beside those owners.
- **Category:** convention
- **Date:** 2026-09-11
- **Source:** accepted Workspace recovery foundations (ADR-044, ADR-047, ADR-048); accepted workspace recovery Gate 3 (supersedes the 2026-08-20 generic-runner instruction from issue 10); user product choice (Pierre as Files chrome, 2026-08-19)

### workspace-golden is not live GitHub or Btrfs proof
- **Rule:** Tagged Storybook `workspace-golden` plays are the required deterministic UI journey ([ADR-045](decisions/ADR-045-required-recovery-ci.md)). They are not live GitHub App publish proof and not sandbox provider proof ([ADR-048](decisions/ADR-048-native-postgres-sandbox-ownership.md)).
- **Category:** convention
- **Date:** 2026-09-11
- **Source:** Gate 6 leftover after deleting docs/plans recovery ledgers

### Claim evidence source ids must be `extractor:repositoryId:…:targetHash`
- **Rule:** Every extractor's `sourceId` must contain `:${repositoryId}:` and end with `:${targetHash}`. `deriveLogicalSourceKey` only strips a *trailing* hash, so a hash placed mid-string makes every re-ingest append a new evidence row to the same claim; retraction and repository purge select evidence by the `:${repositoryId}:` needle plus a `(^|:)path(:|$)` segment regex, so an id without the repository id can never be retracted or purged. A claim extracted in one repository about another (e.g. context-repo PR mirror → source-repo File) must carry both repository ids and the warehouse file path as segments. Add a render→extract→dedup round-trip test for any new extractor.
- **Category:** convention
- **Date:** 2026-09-16
- **Source:** `github-pr-mirror` branch review; PR extract and `linkLocatedPaths` ids embedded the hash mid-string and omitted repository ids (`logicalSourceKey.ts`, `ingestionRetraction.ts`)

### FalkorDB dropped connections must reconnect instead of crashing the worker
- **Rule:** When the FalkorDB client emits `error` (serverless sleep, socket close), log it, drop the shared connection, and reconnect on the next call (`platform/graph/client.ts`). Do not leave an unhandled `error` listener gap — that exits the OpenWorkflow worker. Keep that listener when touching the graph client.
- **Category:** reliability
- **Date:** 2026-09-17
- **Source:** Railway FalkorDB sleep closed the socket mid-ingest; the worker exited and knowledge-graph reads hung until the client learned to reconnect

### A re-index at an unchanged tip is a partial ingest with an empty diff, so nothing is ever retracted
- **Rule:** `repository-ingestion` passes `fromHash = lastIngestedHash` to codesearch; when that commit is an ancestor of the target (including the same commit) the run is `partial`, and `retractIngestionForDiffPg` is a no-op without changed paths while the extractors still re-run over the whole repository. Non-deterministic (LLM) extractors then mint new dedup keys next to the old ones and the object count only grows. Treat "re-index" as `fullReingest: true` (no `fromHash`), have dedup touch every re-observed evidence row (`touchEvidenceBulk` bumps `observedAt`), and after a healthy full run sweep this repository's evidence observed before the index child's `indexedAt` (`retractUnobservedRepositoryEvidencePg`). Take the cutoff from an existing durable step result, not a new step: a new "started at" step executes late for runs already in flight when the worker is redeployed and would sweep the run's own evidence. Do not key the sweep on the commit hash: a re-index at an unchanged tip re-observes at the same hash as the stale rows. Never run the sweep on a degraded run (search/SCIP index failed). When judging a graph change, compare object counts across two runs at the same tip: growth means accumulation, not new knowledge.
- **Category:** reliability
- **Date:** 2026-09-17
- **Source:** `apps/codesearch/src/domain/indexing/phases.ts` mode decision; unchanged-tip re-index accumulated LLM naming drift until the full-ingest sweep landed

### Telemetry attribution must come from auth, never from inbound headers
- **Rule:** On public HTTP services, never copy user/org/actor/request attribution from inbound W3C `baggage` (or any client header) onto spans, logs, jobs, or Langfuse — derive it from the authenticated context only. Only private, internal-only services may read attribution from baggage set by our own callers. Span URLs must never include query strings, fragments, or credentials (tokens, device codes, OAuth `state` ride in query strings), and outgoing-fetch instrumentation should only create child spans under an existing server/job span.
- **Category:** convention
- **Date:** 2026-09-25
- **Source:** PR-343 Opus review of the attribution step (live baggage spoof and reset-token leak into ClickHouse)

### Telemetry export never sits on the request or job path
- **Rule:** Sending logs, spans, or metrics to the collector must not change app behaviour. Exporters buffer and send in the background (evlog `createDrainPipeline`, the OTel batch span processor, a periodic metric reader); a request or job never awaits a network call to the collector. A relay that forwards telemetry has a short upstream timeout. A slow or unreachable collector costs dropped telemetry, never response latency or errors. Flush explicitly only on shutdown or before a script exits.
- **Category:** convention
- **Date:** 2026-09-30
- **Source:** user, after a Railway edge routing incident made the backend's awaited OTLP log drain add 5–15 s to production responses

### The UI is reached through the backend proxy, which rewrites Host
- **Rule:** Browsers load the app from the backend origin; the backend proxies SPA and `/.otel` routes to `UI_PROXY_URL`, so inside `apps/ui` server handlers `request.url`/`Host` is the internal UI host, not the public origin. Any origin, CSRF, redirect, or absolute-URL logic in `apps/ui` must derive the public origin from the forwarded host/proto the backend proxy sets (or from the backend's configured public URL), and must be tested with a proxied request (internal Host + public Origin), not only with Origin == Host.
- **Category:** convention
- **Date:** 2026-09-25
- **Source:** PR-343 `/.otel` same-origin check rejected every browser telemetry post on pr-343 (403) after deploy

### Every runtime import must be a direct `dependency` of its app
- **Rule:** An app's production image installs only its own `dependencies`, so a package imported from non-test code must be listed there, not in `devDependencies` and not only reachable as another package's transitive dependency. pnpm hoisting makes the import resolve locally and in Vitest, so the break shows up only when the built image starts (`Cannot find module …`). When a change adds an import from a new package, add it to that app's `dependencies` in the same commit.
- **Category:** convention
- **Date:** 2026-09-26
- **Source:** PR-343 backend image failed "Verify connector asset contracts" after `otel.ts` imported `@opentelemetry/resources`, which was only a devDependency

### Connector provider reads scale with the data, and full imports resume at the unfinished page
- **Rule:** Source-connector provider calls scale linearly with the amount of data: one request per page of entities or per webhook entity, with related fields batched into that request. They do not scale with the number of relations on each entity (one request per comment, author or parent). A setup catalogue is one query; extra requests are only later pages of that query. A scoped-mirror initial sync checkpoints one OpenWorkflow step per provider page: the step name is the scope id and the page index, and the stored result is the cursor and the rendered text files. Git gets one commit after those pages, so a crash refetches only the page that was not stored. Follow [source-connectors](../../.agents/skills/source-connectors/SKILL.md) steps 6 and 7 when you design or change an integration.
- **Category:** convention
- **Date:** 2026-09-28
- **Source:** user, after Linear relation getters issued one request per comment, user, and team during a large import; user, after a Linear initial sync held the whole mirror in one step and a crash refetched the workspace

### CD applies ops changes; no manual follow-ups
- **Rule:** Do not hand the owner runbook steps, scripts to run, or "after merge" to-dos. Provisioning and one-time cleanups go into the CD workflow, and leftovers from a migration are deleted as part of the work. A Railway setting the Terraform provider omits on update (restart policy, healthcheck, and sleep have `omitempty`) is set once on the service; do not add a workflow script to reapply it, and do not restate platform defaults. The only acceptable owner action is supplying a secret the agent cannot write, stated once with the exact name and location.
- **Category:** convention
- **Date:** 2026-09-26
- **Source:** Repository owner after PR-343 ("I want CD to do these things... you are here to serve me")

### CI from commit to green stays under 10 minutes
- **Rule:** The soft target for the whole CI, from a push to a green result, is under 10 minutes. When a change adds tests or a job, keep the critical path under that target: run independent suites as parallel jobs, shard long suites, cache tool builds and Docker layers, and do not wait on real time in tests (a short test lease or fake timers). Measure the job and step times before and after.
- **Category:** convention
- **Date:** 2026-10-07
- **Source:** repository owner, after PR 280 CI took 45 minutes (ticket 18)

### Vercel sandbox tokens live only in GitHub environments
- **Rule:** The production Vercel token is a secret of the GitHub `Production` environment, which only protected branches can use. Previews and CI use the separate Vercel project `ctxpipe-previews`, and its token is a secret of the `Preview` environment. There is no repository-level `VERCEL_ACCESS_TOKEN`. A workflow job that needs the token declares `environment: Preview` (or `production` on `main`), and a pull request job never gets the production token.
- **Category:** convention
- **Date:** 2026-10-07
- **Source:** repository owner, after a security audit found one Vercel token shared by production, previews and CI
