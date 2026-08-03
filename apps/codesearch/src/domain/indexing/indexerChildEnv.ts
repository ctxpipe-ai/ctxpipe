const INDEXER_CHILD_ENV_ALLOWLIST = [
  "PATH",
  "JAVA_HOME",
  "DOTNET_ROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PUB_CACHE",
  "COMPOSER_HOME",
  "COMPOSER_ALLOW_SUPERUSER",
  "GOROOT",
  "GOPATH",
  "GOBIN",
  "GOTOOLCHAIN",
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_PATH",
  "BUNDLE_APP_CONFIG",
  "GOMAXPROCS",
  "GOGC",
] as const

function copyAllowedIndexerEnv(
  target: Record<string, string | undefined>,
  source: Record<string, string | undefined>,
): void {
  for (const key of INDEXER_CHILD_ENV_ALLOWLIST) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]
    if (value === undefined) {
      delete target[key]
    } else {
      target[key] = value
    }
  }
}

/**
 * Env for repository-controlled indexer subprocesses.
 * Starts from a narrow toolchain allowlist rather than inheriting service env,
 * then caps Go process parallelism (`GOMAXPROCS=2`) and trades some GC CPU for
 * a smaller heap (`GOGC=50`) unless the caller already set those vars.
 *
 * This limits env leakage only; build-aware indexers still execute repository
 * code with the service user and filesystem access. It is not a sandbox.
 */
export function withIndexerGoLimits(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {}
  copyAllowedIndexerEnv(merged, process.env)
  if (env) copyAllowedIndexerEnv(merged, env)

  if (merged.GOMAXPROCS == null || merged.GOMAXPROCS === "") {
    merged.GOMAXPROCS = "2"
  }
  if (merged.GOGC == null || merged.GOGC === "") {
    merged.GOGC = "50"
  }
  return merged
}
