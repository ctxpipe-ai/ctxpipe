import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"
import { log } from "../observability/logger.js"
import { backfillNullOrgIds } from "./backfill-null-org-ids.js"
import { backfillRepositoryIngestionRequests } from "./backfill-repository-ingestion-requests.js"
import { migrateOpenWorkflow } from "./migrate-openworkflow.js"
import { APP_ROLE_NAME, provisionAppRole } from "./provision-app-role.js"
import { reconcileConnectionDirectory } from "./reconcile-connection-directory.js"

/**
 * The one migrate sequence for hosted, Compose, CDK and local dev. Run it as the
 * table owner. Steps: app role, Drizzle, OpenWorkflow, every backfill, grants.
 * Each step is idempotent, so a second run changes nothing.
 */
export async function runMigrations(options: {
  connectionString: string
  appRolePassword: string | undefined
  roleName?: string
  /** How long one statement may wait for a lock outside Drizzle. Default 30 000 ms. */
  lockTimeoutMs?: number
  /**
   * The Drizzle step runs in one transaction that takes strong locks on busy
   * tables. A short lock wait with retries keeps a long transaction of an old
   * service from blocking that service's own queries, and from failing the run.
   */
  drizzleLockRetry?: DrizzleLockRetry
  /** The migration folder. Default: this package's `migrations`. */
  migrationsFolder?: string
}): Promise<void> {
  const roleName = options.roleName ?? APP_ROLE_NAME
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000
  const retry = options.drizzleLockRetry ?? {
    lockTimeoutMs: 5_000,
    tries: 10,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
  }
  // A SET query, not a startup option: a pooled connection string can refuse
  // startup options. Only a lock wait is bounded. A statement timeout would
  // also stop the long backfills.
  const poolWithLockTimeout = (timeoutMs: number) => {
    const created = new Pool({ connectionString: options.connectionString })
    created.on("connect", (client) => {
      client.query(`SET lock_timeout = ${Math.trunc(timeoutMs)}`).catch(() => {
        // The next query on this client shows a broken connection.
      })
    })
    // `pool.end()` resolves before each idle client has closed. When the
    // server ends such a client (for example, a forced DROP DATABASE), the
    // pool sends an "error" event. With no listener, that event is an
    // unhandled error. A query error still comes back to its caller.
    created.on("error", (error) => {
      log.warn({
        step: "migrate",
        message: "[migrate] an idle database connection closed",
        error: error.message,
      })
    })
    return created
  }
  const pool = poolWithLockTimeout(lockTimeoutMs)
  try {
    // First, so that a missing role stops migrate before the schema changes.
    await provisionAppRole(pool, options.appRolePassword, roleName)

    log.info({ step: "migrate", message: "[migrate] running migrations…" })
    await migrateWithLockRetry(
      poolWithLockTimeout(retry.lockTimeoutMs),
      retry,
      options.migrationsFolder ??
        fileURLToPath(new URL("../../migrations", import.meta.url)),
    )
    await migrateOpenWorkflow(options.connectionString)

    await backfillNullOrgIds(pool)
    await backfillRepositoryIngestionRequests(pool)
    const directory = await reconcileConnectionDirectory(pool)
    log.info({
      step: "migrate",
      message: "[migrate] reconciled connection_directory",
      ...directory,
    })

    // Again after the migrations, for the tables and schemas they added.
    await provisionAppRole(pool, undefined, roleName)
  } catch (error) {
    if (!(error instanceof LockRetriesExhaustedError) && isLockTimeout(error))
      throw new Error(
        `[migrate] A statement waited more than ${lockTimeoutMs} ms for a database lock. Another session holds the lock. End that session, then run migrate again.`,
        { cause: error },
      )
    throw error
  } finally {
    await pool.end()
  }
}

type DrizzleLockRetry = {
  lockTimeoutMs: number
  tries: number
  baseDelayMs: number
  maxDelayMs: number
  /** Called after a rolled-back try, before the wait. */
  onRetry?: (retry: { attempt: number; waitMs: number }) => void | Promise<void>
}

class LockRetriesExhaustedError extends Error {}

function isLockTimeout(error: unknown): boolean {
  const code =
    (error as { code?: string }).code ??
    (error as { cause?: { code?: string } }).cause?.code
  return code === "55P03"
}

/**
 * Drizzle applies all pending migrations in one transaction, so a lock timeout
 * rolls back the whole run and a new try starts clean. Only a lock timeout
 * retries. The delay doubles up to the cap.
 */
async function migrateWithLockRetry(
  pool: Pool,
  retry: DrizzleLockRetry,
  migrationsFolder: string,
): Promise<void> {
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await migrate(drizzle({ client: pool }), { migrationsFolder })
        return
      } catch (error) {
        if (!isLockTimeout(error)) throw error
        if (attempt >= retry.tries)
          throw new LockRetriesExhaustedError(
            `[migrate] A migration statement waited more than ${retry.lockTimeoutMs} ms for a database lock on each of ${retry.tries} tries. Another session holds the lock, often a long transaction of a running service. End that session, or stop the old services, then run migrate again.`,
            { cause: error },
          )
        const waitMs = Math.min(
          retry.baseDelayMs * 2 ** (attempt - 1),
          retry.maxDelayMs,
        )
        log.warn({
          step: "migrate",
          message:
            "[migrate] lock timeout, the migration rolled back; retrying",
          attempt,
          tries: retry.tries,
          waitMs,
        })
        await retry.onRetry?.({ attempt, waitMs })
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }
  } finally {
    await pool.end()
  }
}
