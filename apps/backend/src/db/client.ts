import { AsyncLocalStorage } from "node:async_hooks"
import { setDefaultResultOrder } from "node:dns"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { log } from "../observability/logger.js"
import { relations, schema } from "./schema.js"
import {
  formatUnknownError,
  wrapPoolQueryWithTransientRetry,
} from "./transientDbRetry.js"

// Prefer A records. Happy Eyeballs waiting on a dead AAAA to Neon is ~1s
// per new TCP connect — the same shape as a transpacific org-SQL hop.
setDefaultResultOrder("ipv4first")

function isRailwayPrPreview(): boolean {
  return Boolean(process.env.RAILWAY_ENVIRONMENT_NAME?.trim().startsWith("pr-"))
}

function createDrizzleDb(connectionString: string) {
  // Railway Serverless sleeps after ~10m with no outbound. Long-lived idle
  // Neon connections (and TCP keepalives) prevent that window in PR previews.
  const client = new Pool({
    connectionString,
    max: 50,
    allowExitOnIdle: isRailwayPrPreview(),
    keepAlive: true,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 30_000,
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
  const originalConnect = client.connect.bind(client)
  client.connect = ((callback?: (err: Error | undefined, client?: unknown) => void) => {
    const started = Date.now()
    if (callback) return originalConnect(callback)
    return originalConnect().then((poolClient) => {
      const ms = Date.now() - started
      if (ms >= 50) {
        log.info({
          step: "db.pool.connect",
          message: `pg pool connect ${ms}ms`,
          ms,
          replicaRegion: process.env.RAILWAY_REPLICA_REGION,
        })
      }
      return poolClient
    })
  }) as typeof client.connect
  wrapPoolQueryWithTransientRetry(client)
  return drizzle({ client, schema, relations })
}

type AppDb = ReturnType<typeof createDrizzleDb>
export type Db = Omit<AppDb, "$client">

type OrgDbStore = { db: Db; orgId: string }

const systemDbStorage = new AsyncLocalStorage<Db>()
const orgDbStorage = new AsyncLocalStorage<OrgDbStore>()
let appDb: AppDb | null = null

export function initDb(connectionString: string): Db {
  if (appDb) return appDb
  appDb = createDrizzleDb(connectionString)
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
  const stored = orgDbStorage.getStore()
  if (stored) return stored.db
  throw new Error(
    "Org database not initialized. Call withOrgDbContext() during startup.",
  )
}

/** Returns the current org DB transaction when inside `withOrgDbContext`, else undefined. */
export function tryGetOrgDb(): Db | undefined {
  return orgDbStorage.getStore()?.db
}

export function tryGetOrgDbOrgId(): string | undefined {
  return orgDbStorage.getStore()?.orgId
}

/**
 * Throws if an org SQL transaction is open. Call at HTTP/enqueue/graph
 * gateways so I/O cannot run inside `BEGIN`.
 */
export function assertNotInOrgDbContext(): void {
  if (orgDbStorage.getStore()) {
    throw new Error(
      "Outbound I/O cannot run inside withOrgDbContext; finish the SQL transaction first.",
    )
  }
}

export type OrgDbContextOptions = {
  isolationLevel?: "repeatable read"
  idleInTransactionSessionTimeout?: string
}

/**
 * Short org SQL transaction (`SET LOCAL app.organization_id`).
 * Nested same-org calls reuse this transaction (no second pool checkout).
 * Nested different-org calls throw. Inner throw aborts the outer transaction
 * (no savepoints); independent commits must run after this handler returns.
 */
export async function withOrgDbContext<T>(
  orgId: string,
  handler: (db: Db) => Promise<T>,
  options?: OrgDbContextOptions,
): Promise<T> {
  const existing = orgDbStorage.getStore()
  if (existing) {
    if (existing.orgId !== orgId) {
      throw new Error(
        `withOrgDbContext nested org mismatch: open=${existing.orgId} requested=${orgId}`,
      )
    }
    if (options?.isolationLevel)
      throw new Error("Snapshot isolation requires a new org transaction")
    if (options?.idleInTransactionSessionTimeout) {
      throw new Error(
        "idleInTransactionSessionTimeout cannot be applied to a nested withOrgDbContext",
      )
    }
    return handler(existing.db)
  }
  const db = getSystemDb()
  const started = Date.now()
  let setMs = 0
  let handlerMs = 0
  const result = await db.transaction(
    async (tx) => {
      const idleTimeout = options?.idleInTransactionSessionTimeout
      const setStarted = Date.now()
      // One round-trip for both GUCs. Nested same-org calls reuse this tx.
      await tx.execute(
        idleTimeout
          ? sql`select set_config('app.organization_id', ${orgId}, true), set_config('idle_in_transaction_session_timeout', ${idleTimeout}, true)`
          : sql`select set_config('app.organization_id', ${orgId}, true)`,
      )
      setMs = Date.now() - setStarted
      const handlerStarted = Date.now()
      try {
        // Explicit `async` wrapper: some runtimes (e.g. Bun inside OpenWorkflow steps)
        // drop AsyncLocalStorage across `() => handler(tx)` when `handler` is async.
        return await orgDbStorage.run({ db: tx, orgId }, async () =>
          handler(tx),
        )
      } catch (err) {
        log.error({
          step: "withOrgDbContext.rollback",
          message: "withOrgDbContext: transaction rollback",
          orgId,
          error: formatUnknownError(err),
          cause: err instanceof Error ? err.cause : undefined,
        })
        throw err
      } finally {
        handlerMs = Date.now() - handlerStarted
      }
    },
    options?.isolationLevel
      ? { isolationLevel: options.isolationLevel }
      : undefined,
  )
  const totalMs = Date.now() - started
  if (totalMs >= 50) {
    log.info({
      step: "db.org_tx",
      message: `org SQL tx ${totalMs}ms`,
      orgId,
      totalMs,
      setMs,
      handlerMs,
      beginCommitMs: totalMs - setMs - handlerMs,
      replicaRegion: process.env.RAILWAY_REPLICA_REGION,
    })
  }
  return result
}

export async function closeDb(): Promise<void> {
  if (!appDb) return
  await appDb.$client.end()
  appDb = null
}
