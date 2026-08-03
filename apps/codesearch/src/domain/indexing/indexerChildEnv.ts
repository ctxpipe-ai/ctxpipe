const INDEXER_CHILD_ENV_ALLOWLIST = [
  // Process / runtime (non-secret; many toolchains derive caches from HOME)
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "CI",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // Java / .NET / Rust / Dart / PHP tool homes set by the codesearch image
  "JAVA_HOME",
  "DOTNET_ROOT",
  "NUGET_PACKAGES",
  "DOTNET_CLI_HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PUB_CACHE",
  "COMPOSER_HOME",
  "COMPOSER_ALLOW_SUPERUSER",
  // Go
  "GOROOT",
  "GOPATH",
  "GOBIN",
  "GOTOOLCHAIN",
  "GOMODCACHE",
  "GOCACHE",
  "GOPROXY",
  "GOSUMDB",
  "GO111MODULE",
  "GOMAXPROCS",
  "GOGC",
  // Node / Python / Ruby
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
  "PIP_CACHE_DIR",
  "PYTHONUSERBASE",
  "PYTHONPATH",
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_PATH",
  "BUNDLE_APP_CONFIG",
] as const

/** Writable Go cache root when neither GOPATH nor GOMODCACHE is set and HOME is missing. */
const DEFAULT_GO_CACHE_ROOT = "/tmp/ctxpipe-go"

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

function applyGoCacheDefaults(env: Record<string, string | undefined>): void {
  const hasGopath = env.GOPATH != null && env.GOPATH !== ""
  const hasGomodcache = env.GOMODCACHE != null && env.GOMODCACHE !== ""
  if (hasGopath || hasGomodcache) return

  const home = env.HOME != null && env.HOME !== "" ? env.HOME : null
  const root = home ? `${home}/go` : DEFAULT_GO_CACHE_ROOT
  env.GOPATH = root
  env.GOMODCACHE = `${root}/pkg/mod`
  if (env.GOCACHE == null || env.GOCACHE === "") {
    env.GOCACHE = home
      ? `${home}/.cache/go-build`
      : `${DEFAULT_GO_CACHE_ROOT}/cache`
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
  applyGoCacheDefaults(merged)
  return merged
}
