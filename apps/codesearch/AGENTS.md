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

## Testing

- Keep unit tests collocated with the code under `src/`.
- The default `pnpm --filter @ctxpipe/codesearch test` builds and runs the
  Docker-based Vitest suite.
- After significant ingest changes, run the manual Kubernetes memory gate from
  the repository root:

  ```bash
  pnpm --filter @ctxpipe/codesearch test:manual:kubernetes-memory
  ```

  Significant changes include Zoekt invocation, SCIP indexer selection or
  concurrency, child-process/log handling, clone/checkout behavior, and index
  artifact creation. This expensive networked gate is intentionally excluded
  from the default test command. It must exit 0 without OOM/137 and produce
  non-empty merged and language-specific `.scip` artifacts.

- The gate's `MEMORY_MAX` is currently marked `PLACEHOLDER`. Calibrate it with
  repeated runs, use the measured VmHWM/cgroup peak plus 10-15% headroom (at
  most 512 MiB headroom), then replace the placeholder with the locked ceiling.
