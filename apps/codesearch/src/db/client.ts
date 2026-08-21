import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import type { Env } from "../config/env.js"
import { log } from "../observability/logger.js"
import * as schema from "./schema.js"
import {
  attachPoolErrorListener,
  wrapPoolQueryWithTransientRetry,
} from "./transient.js"

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
  attachPoolErrorListener(client)
  wrapPoolQueryWithTransientRetry(client)
  return drizzle({ client, schema })
}

export type Db = ReturnType<typeof createDb>

type OrgDbStore = { db: Db; orgId: string }

const orgDbStorage = new AsyncLocalStorage<OrgDbStore>()

export function tryGetOrgDb(): Db | undefined {
  return orgDbStorage.getStore()?.db
}

export function tryGetOrgDbOrgId(): string | undefined {
  return orgDbStorage.getStore()?.orgId
}

export function getOrgDb(): Db {
  const stored = orgDbStorage.getStore()
  if (stored) return stored.db
  throw new Error(
    "Org database not initialized. Call withOrgDbContext() first.",
  )
}

/** Throws if an org SQL transaction is open. Call at git/Zoekt/SCIP gateways. */
export function assertNotInOrgDbContext(): void {
  if (orgDbStorage.getStore()) {
    throw new Error(
      "Outbound I/O cannot run inside withOrgDbContext; finish the SQL transaction first.",
    )
  }
}

/**
 * Short org SQL transaction (`SET LOCAL app.organization_id`).
 * Nested same-org calls reuse this transaction. Nested different-org throws.
 * Never wrap clone / Zoekt / SCIP I/O in this helper.
 */
export async function withOrgDbContext<T>(
  db: Db,
  orgId: string,
  handler: (tx: Db) => Promise<T>,
): Promise<T> {
  const existing = orgDbStorage.getStore()
  if (existing) {
    if (existing.orgId !== orgId) {
      throw new Error(
        `withOrgDbContext nested org mismatch: open=${existing.orgId} requested=${orgId}`,
      )
    }
    return handler(existing.db)
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.organization_id', ${orgId}, true)`,
    )
    try {
      return await orgDbStorage.run({ db: tx, orgId }, async () => handler(tx))
    } catch (err) {
      log.error({
        step: "withOrgDbContext.rollback",
        message: "withOrgDbContext: transaction rollback",
        orgId,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  })
}
