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

## Testing

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
