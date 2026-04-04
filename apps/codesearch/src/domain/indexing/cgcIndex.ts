/**
 * CodeGraphContext (`cgc`) indexing strategy for codesearch checkouts.
 *
 * **Full ingest:** `cgc index . --force` rebuilds the Kùzu graph from scratch for the
 * checkout — slow on large repos but simplest.
 *
 * **Partial ingest:** Prefer incremental `cgc index .` (no `--force`) so the CLI can
 * merge updates into the existing `KUZUDB_PATH` after `git` changed files.
 * If that fails (e.g. first run on an empty DB), callers may fall back to `--force`.
 *
 * **Watch:** `ensureCgcWatchBeforeCheckout` in `cgcWatchRegistry.ts` starts a singleton
 * `cgc watch .` child per absolute `KUZUDB_PATH` before `git checkout`, so checkout
 * churn is observed incrementally. `cgc index` remains the durability pass after
 * checkout. Deployment images run `cgc watch --help` at build time; integration tests
 * in `executeGraphPrimitive.integration.test.ts` probe `cgc watch --help` when CGC is on PATH.
 */
export function cgcIndexArgsForIngestMode(ingestMode: "full" | "partial"): {
  args: string[]
  allowForceFallback: boolean
} {
  if (ingestMode === "partial") {
    return { args: ["cgc", "index", "."], allowForceFallback: true }
  }
  return { args: ["cgc", "index", ".", "--force"], allowForceFallback: false }
}
