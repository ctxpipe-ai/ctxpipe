import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import type { Env } from "../config/env.js"
import * as schema from "./schema.js"

/**
 * Create a Drizzle client for PostgreSQL (read-only usage).
 * Uses DATABASE_URL from env. Schema from backend (repositories).
 */
export function createDb(env: Env) {
  const connectionString = env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for database operations")
  }
  const client = new Pool({
    connectionString,
    idleTimeoutMillis: 300_000,
    keepAlive: true,
  })
  return drizzle({ client, schema })
}

export type Db = ReturnType<typeof createDb>
