import pg from "pg"

import { ownerUrlForMigrate } from "../db/owner-migrate-url.js"

/**
 * Analyzes tables as their owner. A new bulk load has no planner statistics
 * until autovacuum analyzes it, and only the table owner can analyze.
 */
export async function analyzeAsOwner(
  databaseUrl: string,
  tables: readonly string[],
): Promise<void> {
  const owner = new pg.Client({
    connectionString: ownerUrlForMigrate(databaseUrl),
  })
  await owner.connect()
  try {
    await owner.query(`ANALYZE ${tables.join(", ")}`)
  } finally {
    await owner.end()
  }
}
