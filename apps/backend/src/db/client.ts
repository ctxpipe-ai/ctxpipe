import { AsyncLocalStorage } from "node:async_hooks"
import { drizzle } from "drizzle-orm/node-postgres"
import { parseEnv } from "../config/env.js"
import { relations, schema } from "./schema.js"

/**
 * Create a Drizzle client for PostgreSQL. Uses DATABASE_URL from process.env.
 * Works with any Postgres provider (Neon, Supabase, on-prem, etc.).
 */
export function createDb() {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const connectionString = env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for database operations")
  }
  return drizzle(connectionString, { schema, relations })
}

export type Db = ReturnType<typeof createDb>

const dbStorage = new AsyncLocalStorage<Db>()

export async function withDbContext<T>(
  handler: (db: Db) => Promise<T>,
): Promise<T> {
  const db = createDb()
  return dbStorage.run(db, async () => {
    try {
      return await handler(db)
    } finally {
      await db.$client.end()
    }
  })
}

export function getDb(): Db {
  const db = dbStorage.getStore()
  if (db) return db
  return createDb()
}
