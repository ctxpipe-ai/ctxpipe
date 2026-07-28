/**
 * CodeGraphContext (`cgc`) indexing strategy for codesearch checkouts.
 *
 * **Full ingest:** `cgc index . --force` rebuilds the Kùzu graph from scratch for the
 * checkout — slow on large repos but simplest.
 *
 * **Partial ingest:** Prefer incremental `cgc index .` (no `--force`) so the CLI can
 * merge updates into the existing `KUZUDB_PATH` after `git checkout` updates the
 * working tree. If that fails (e.g. first run on an empty DB), callers may fall back
 * to `--force`.
 *
 * Indexing always runs an awaited `cgc index` pass after Zoekt indexing on the checked-out
 * tree — no persistent `cgc watch` children. Failure fails the `/index` request so
 * downstream LLM ingest never starts on a stale Kùzu DB.
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

/**
 * After the primary `cgc index` exit (and optional `--force` fallback), throw unless
 * at least one attempt succeeded. Callers must fail the `/index` request so LLM ingest
 * never starts on a stale Kùzu DB.
 */
export function assertCgcIndexSucceeded(params: {
  primaryExit: number
  allowForceFallback: boolean
  forceExit?: number
}): void {
  if (params.primaryExit === 0) return
  if (params.allowForceFallback && params.forceExit === 0) return
  const exit =
    params.allowForceFallback && params.forceExit !== undefined
      ? params.forceExit
      : params.primaryExit
  throw new Error(`cgc index failed with exit code ${exit}`)
}
