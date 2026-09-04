import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { log } from "../observability/logger.js"
import { relations, schema } from "./schema.js"
import {
  type DbConnectionAcquisitionRetryOptions,
  formatUnknownError,
  wrapPoolQueryWithConnectionAcquisitionRetry,
} from "./transientDbRetry.js"

function isRailwayPrPreview(): boolean {
  return Boolean(process.env.RAILWAY_ENVIRONMENT_NAME?.trim().startsWith("pr-"))
}

function createDrizzleDb(
  connectionString: string,
  retryOptions?: DbConnectionAcquisitionRetryOptions,
) {
  // Railway Serverless sleeps after ~10m with no outbound. Long-lived idle
  // Neon connections (and TCP keepalives) prevent that window in PR previews.
  const client = new Pool({
    connectionString,
    allowExitOnIdle: isRailwayPrPreview(),
    keepAlive: true,
    idleTimeoutMillis: 30_000,
    // Fail fast enough for routes to return a retryable 503 instead of holding
    // CLI and MCP callers on an unavailable database socket for 30 seconds.
    connectionTimeoutMillis: 5_000,
    application_name: "ctxpipe-backend",
  })
  // Idle clients can emit 'error' when Postgres closes them (e.g. 25P03
  // idle_in_transaction). Without a listener, Node treats that as uncaught
  // and can exit the OpenWorkflow worker process.
  client.on("error", (err) => {
    log.error({
      step: "db.pool",
      message: "Unexpected pg pool error",
      error: err instanceof Error ? err.message : String(err),
      code:
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : undefined,
    })
  })
  wrapPoolQueryWithConnectionAcquisitionRetry(client, retryOptions)
  return drizzle({ client, schema, relations })
}

type AppDb = ReturnType<typeof createDrizzleDb>
export type Db = Omit<AppDb, "$client">

const systemDbStorage = new AsyncLocalStorage<Db>()
const orgDbStorage = new AsyncLocalStorage<Db>()
let appDb: AppDb | null = null

export function initDb(
  connectionString: string,
  retryOptions?: DbConnectionAcquisitionRetryOptions,
): Db {
  if (appDb) return appDb
  appDb = createDrizzleDb(connectionString, retryOptions)
  return appDb
}

export async function withSystemDbContext<T>(
  handler: (db: Db) => Promise<T>,
): Promise<T> {
  const db = getSystemDb()
  return systemDbStorage.run(db, () => handler(db))
}

export function getSystemDb(): Db {
  const db = systemDbStorage.getStore()
  if (db) return db
  if (appDb) return appDb
  throw new Error("Database not initialized. Call initDb() during startup.")
}

export function getOrgDb(): Db {
  const db = orgDbStorage.getStore()
  if (db) return db
  throw new Error(
    "Org database not initialized. Call withOrgDbContext() during startup.",
  )
}

/** Returns the current org DB transaction when inside `withOrgDbContext`, else undefined. */
export function tryGetOrgDb(): Db | undefined {
  return orgDbStorage.getStore()
}

export type OrgDbContextOptions = {
  idleInTransactionSessionTimeout?: string
}

export async function withOrgDbContext<T>(
  orgId: string,
  handler: (db: Db) => Promise<T>,
  options?: OrgDbContextOptions,
): Promise<T> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.organization_id', ${orgId}, true)`,
    )
    if (options?.idleInTransactionSessionTimeout) {
      await tx.execute(
        sql`select set_config('idle_in_transaction_session_timeout', ${options.idleInTransactionSessionTimeout}, true)`,
      )
    }
    try {
      // Explicit `async` wrapper: some runtimes (e.g. Bun inside OpenWorkflow steps)
      // drop AsyncLocalStorage across `() => handler(tx)` when `handler` is async.
      return await orgDbStorage.run(tx, async () => handler(tx))
    } catch (err) {
      log.error({
        step: "withOrgDbContext.rollback",
        message: "withOrgDbContext: transaction rollback",
        orgId,
        error: formatUnknownError(err),
        cause: err instanceof Error ? err.cause : undefined,
      })
      throw err
    }
  })
}

export async function closeDb(): Promise<void> {
  if (!appDb) return
  await appDb.$client.end()
  appDb = null
}
