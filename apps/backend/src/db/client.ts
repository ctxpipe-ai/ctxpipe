import { drizzle } from "drizzle-orm/node-postgres"
import type { Env } from "../config/env.js"
import * as schema from "./schema/index.js"

/**
 * Create a Drizzle client for PostgreSQL. Uses DATABASE_URL from env.
 * Works with any Postgres provider (Neon, Supabase, on-prem, etc.).
 */
export function createDb(env: Env) {
  const connectionString = env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for database operations")
  }
  return drizzle(connectionString, { schema })
}

export type Db = ReturnType<typeof createDb>
