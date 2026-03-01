import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { relations, schema } from "./schema.js"

function createDrizzleDb(connectionString: string) {
  return drizzle(connectionString, { schema, relations })
}

type AppDb = ReturnType<typeof createDrizzleDb>
export type Db = Omit<AppDb, "$client">

const dbStorage = new AsyncLocalStorage<Db>()
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
  return dbStorage.run(db, () => handler(db))
}

export function getSystemDb(): Db {
  const db = dbStorage.getStore()
  if (db) return db
  if (appDb) return appDb
  throw new Error("Database not initialized. Call initDb() during startup.")
}

export async function withOrgDbContext<T>(
  orgId: string,
  handler: (db: Db) => Promise<T>,
): Promise<T> {
  const db = getSystemDb()
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.organization_id', ${orgId}, true)`,
    )
    return dbStorage.run(tx, () => handler(tx))
  })
}

export async function closeDb(): Promise<void> {
  if (!appDb) return
  await appDb.$client.end()
  appDb = null
}
