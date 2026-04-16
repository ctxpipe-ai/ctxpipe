import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
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

function getAppDb(): AppDb {
  if (!appDb) {
    throw new Error("Database not initialized. Call initDb() during startup.")
  }
  return appDb
}

export function initDb(connectionString: string): Db {
  if (appDb) return appDb
  appDb = createDrizzleDb(connectionString)
  return appDb
}

export async function withSystemDbContext<T>(
  handler: (db: Db) => Promise<T>,
): Promise<T> {
  return getAppDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.system_access', 'true', true)`)
    return systemDbStorage.run(tx, () => handler(tx))
  })
}

export function getSystemDb(): Db {
  const db = systemDbStorage.getStore()
  if (db) return db
  return getAppDb()
}

export function getOrgDb(): Db {
  const db = orgDbStorage.getStore()
  if (db) return db
  throw new Error(
    "Org database not initialized. Call withOrgDbContext() during startup.",
  )
}

export async function withOrgDbContext<T>(
  orgId: string,
  handler: (db: Db) => Promise<T>,
): Promise<T> {
  return getAppDb().transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.organization_id', ${orgId}, true)`,
    )
    await tx.execute(
      sql`select set_config('app.system_access', 'false', true)`,
    )
    try {
      return await orgDbStorage.run(tx, () => handler(tx))
    } catch (err) {
      console.error("withOrgDbContext: transaction rollback", {
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
