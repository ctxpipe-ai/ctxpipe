/**
 * Env for memory-heavy Go indexers (zoekt-index, scip-go, etc.).
 * Caps parallelism / GC overhead unless the caller already set the vars.
 */
export function withIndexerGoLimits(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  }
  if (merged.GOMAXPROCS == null || merged.GOMAXPROCS === "") {
    merged.GOMAXPROCS = "2"
  }
  if (merged.GOGC == null || merged.GOGC === "") {
    merged.GOGC = "50"
  }
  return merged
}
