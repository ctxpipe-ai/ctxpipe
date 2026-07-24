import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { log } from "../observability/logger.js"
import { relations, schema } from "./schema.js"

function createDrizzleDb(connectionString: string) {
  const client = new Pool({
    connectionString,
    idleTimeoutMillis: 300000,
  })
  return drizzle({ client, schema, relations })
}

type AppDb = ReturnType<typeof createDrizzleDb>
export type Db = Omit<AppDb, "$client">

const systemDbStorage = new AsyncLocalStorage<Db>()
const orgDbStorage = new AsyncLocalStorage<Db>()
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
  const db = orgDbStorage.getStore()
  if (db) return db
  throw new Error(
    "Org database not initialized. Call withOrgDbContext() during startup.",
  )
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
        error: err instanceof Error ? err.message : String(err),
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
