import type { PoolConfig } from "pg"
import { Pool } from "pg"
import { log } from "../observability/logger.js"

/** Recycle pooled connections before typical proxy/LB idle cuts (~60s). */
const POOL_IDLE_TIMEOUT_MS = 30_000

/** Cap connection lifetime to avoid long-lived sockets that infra may reset. */
const POOL_MAX_USES = 5_000

type PgSslConfig = boolean | { rejectUnauthorized: boolean }

function resolveSslFromConnectionUrl(connectionString: string): {
  ssl?: PgSslConfig
  /** Connection string with sslmode stripped so pg does not re-parse ambiguously. */
  connectionString: string
} {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    return { connectionString }
  }

  const sslmode = url.searchParams.get("sslmode")
  if (!sslmode) {
    return { connectionString }
  }

  url.searchParams.delete("sslmode")
  const cleaned = url.toString()

  const ssl = sslConfigForMode(sslmode)
  return ssl === undefined ? { connectionString: cleaned } : { ssl, connectionString: cleaned }
}

function sslConfigForMode(sslmode: string): PgSslConfig | undefined {
  switch (sslmode) {
    case "disable":
      return false
    case "no-verify":
      return { rejectUnauthorized: false }
    case "prefer":
    case "require":
      // libpq-compatible: TLS without strict hostname verification (Neon/RDS poolers).
      return { rejectUnauthorized: false }
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true }
    default:
      return { rejectUnauthorized: true }
  }
}

export type CreatePgPoolOptions = {
  connectionString: string
  /** Shown in pg_stat_activity; defaults to `ctxpipe-backend`. */
  applicationName?: string
  max?: number
}

/**
 * Shared pg.Pool defaults for API, auth (Better Auth), and workers.
 * Mitigates stale connections dropped by poolers/LBs and clarifies SSL from DATABASE_URL.
 */
function hostPortUserFromUrl(connectionString: string): Pick<
  PoolConfig,
  "host" | "port" | "user" | "password" | "database"
> {
  try {
    const url = new URL(connectionString)
    const database = url.pathname.replace(/^\//, "") || undefined
    return {
      host: url.hostname || undefined,
      port: url.port ? Number.parseInt(url.port, 10) : undefined,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      database: database ? decodeURIComponent(database) : undefined,
    }
  } catch {
    return {}
  }
}

export function buildPgPoolConfig(options: CreatePgPoolOptions): PoolConfig {
  const { ssl, connectionString } = resolveSslFromConnectionUrl(
    options.connectionString,
  )

  const config: PoolConfig = {
    connectionString,
    ...hostPortUserFromUrl(connectionString),
    ssl,
    keepAlive: true,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000,
    maxUses: POOL_MAX_USES,
    application_name: options.applicationName ?? "ctxpipe-backend",
    max: options.max,
  }

  return config
}

/**
 * One immediate retry on transient socket drops (common behind poolers during session lookup).
 */
export class RetryingPgPool extends Pool {
  // biome-ignore lint/suspicious/noExplicitAny: pg query overloads
  override query(...args: any[]): any {
    const run = () => super.query(...args)
    return run().catch((err: unknown) => {
      if (!isTransientPgConnectionError(err)) throw err
      return run()
    })
  }
}

export function createPgPool(options: CreatePgPoolOptions): Pool {
  const pool = new RetryingPgPool(buildPgPoolConfig(options))

  pool.on("error", (err) => {
    log.error({
      step: "db.pool",
      message: "Postgres pool idle client error",
      applicationName: options.applicationName ?? "ctxpipe-backend",
      error: err instanceof Error ? err.message : String(err),
      code:
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code)
          : undefined,
    })
  })

  return pool
}

/** True when pg/pg-pool reports a dropped or reset connection (retry-safe). */
export function isTransientPgConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const message = err.message.toLowerCase()
  if (
    message.includes("connection terminated") ||
    message.includes("connection terminated unexpectedly") ||
    message.includes("connection reset") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("client has encountered a connection error")
  ) {
    return true
  }
  const code =
    err && typeof err === "object" && "code" in err
      ? (err as { code?: string }).code
      : undefined
  return code === "ECONNRESET" || code === "57P01" || code === "08006" || code === "08003"
}
