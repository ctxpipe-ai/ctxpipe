# Codesearch agent instructions

These instructions supplement the repository-root `AGENTS.md`.

## Service boundaries

- Codesearch is a Bun/Hono service that orchestrates Zoekt and SCIP indexing.
- Treat the backend-owned `repositories` schema as read-only except for the
  narrow indexing lifecycle updates already implemented here. Database
  migrations belong in `apps/backend`.
- Keep OpenAPI route schemas collocated with routes and use Zod validation.
- Use the fixed repository-cache and index path helpers rather than introducing
  new path conventions.
- **Zoekt hot/cold:** Durable shards live in `ZOEKT_INDEX_DIR` (cold).
  `zoekt-webserver` watches the sibling `zoekt-hot` directory (derived in
  `src/config/paths.ts` — no separate env var). Bun pins repos by symlink on
  `/search` and unloads after ~5 minutes idle. Do not write real shard files
  into hot.

## Logging (evlog)

- **Do not use `console.*`** in `apps/codesearch` TypeScript — logs must go through **evlog** ([`src/observability/logger.ts`](src/observability/logger.ts)).
- **Hono handlers**: use **`getLogger()`** (request-scoped via `evlog/hono`). Prefer structured `step` fields.
- **Domain / background code** without a request logger: use **`log`** from the same module (`log.info({ step, … })` / `log.error({ step, error, … })`).
- Long `/index` work: emit phase milestones and ~30s heartbeats (`codesearch.index.phase.*`) and call **`flushWorkflowLog()`** so events leave the process before the HTTP handler returns. Indexing log helper: [`src/observability/indexingLog.ts`](src/observability/indexingLog.ts).

### Operator notes (ingestion)

- Durable ingestion uses OpenWorkflow **`repository-index`** child steps that call codesearch phase APIs (`/clone-checkout`, `/zoekt`, `/detect-languages`, `/scip/{lang}`, `/merge-scip`). Legacy monolithic `POST /:repoId/index` remains as a composer for non-OW callers.
- Quiet OpenRouter / empty Langfuse during a long job usually means the workflow is still in **codesearch index phases** (UI badge word **`indexing`**; Zoekt is step key **`indexing_search`** / step **6**), not idle.
- Look for `codesearch.index.phase.*` / `codesearch.index.queue.*` in codesearch logs and `repository-index.*` / `repository-ingestion.step.*` on the worker.
- OpenWorkflow step failures are logged to evlog as `repository-ingestion.step.<name>.attempt_failed` (and orchestrator `…child-failed`) — do not rely on the OpenWorkflow dashboard.
- Langfuse / LLM work starts at durable extract steps (`identify-roots`, `extract-kind:*`, `identify:*`) after retract (UI badge **`analyzing`** and later).
- **TypeScript SCIP projects:** every directory with a `tsconfig.json` (or only a `jsconfig.json`), including the root, is its own `scip-typescript` run, deepest first. A project with nested projects runs a derived `tsconfig.ctxpipe-scip.json` that also excludes their directories, so each file is indexed once. For the run, monorepo packages (`pnpm-workspace.yaml`, `package.json` `workspaces`, `lerna.json`) are symlinked into a root `node_modules` (so `extends: "@scope/tsconfig/…"` resolves without an install), and a root `package.json` is ensured (symbols never embed the checkout path); all of it is removed afterwards and replaced if a crash left it. Each child gets `--max-old-space-size` of ¾ of its memory share (up to 8 GB). Projects without inputs are skipped. When some projects fail, the shard still merges and the phase returns an `issue` that the repository shows as `complete_with_issues`; per-project `scip.typescript.project` spans and `codesearch.index.scip.typescript_project_failed` / `…typescript_projects` events carry the detail. When all fail, the phase fails, except in a repository whose only configs are nested and that has no workspace (e.g. a docs site in a Go repo), which soft-skips with an empty shard (`…typescript_soft_skipped`).
- **Zoekt and SCIP optional:** the OW path continues extract after Zoekt and/or SCIP failure (`searchIndexOk: false` and/or `scipIndexOk: false` → `complete_with_issues`). Lexical search and/or graph tools may be empty; checkout and ast-grep still work. Clone failure remains fail-closed. Per-language SCIP failures merge surviving shards. Zoekt memory-fit failure skips SCIP langs (OW and legacy `POST /index`) to protect extract.

## Testing

- Testing: [root AGENTS.md → Testing](../../AGENTS.md#testing).
- Keep unit tests collocated with the code under `src/`.
- The default `pnpm --filter @ctxpipe/codesearch test` builds and runs the
  Docker-based Vitest suite.
- After significant ingest changes, run the manual Kubernetes memory gate from
  the repository root:

  ```bash
  pnpm --filter @ctxpipe/codesearch test:manual:kubernetes-memory
  ```

  Significant changes include Zoekt invocation, hot/cold pin management, SCIP
  indexer selection or concurrency, child-process/log handling, clone/checkout
  behavior, and index artifact creation. This expensive networked gate is
  intentionally excluded from the default test command. It must exit 0 without
  OOM/137, produce non-empty merged and language-specific `.scip` artifacts,
  write kubernetes shards only under cold `ZOEKT_INDEX_DIR`, and leave `zoekt-hot`
  empty (ingest must not pin).

- The gate currently keeps provisional `MEMORY_MAX=5670m` from the prior
  kubernetes@v1.36.3 calibration (~5158 MiB peak + 512 MiB headroom). Re-run the
  gate after hot/cold or ingest changes and update the ceiling from the
  printed peak before raising it — do not treat 5670m as a new-model
  calibration until that re-run lands.
