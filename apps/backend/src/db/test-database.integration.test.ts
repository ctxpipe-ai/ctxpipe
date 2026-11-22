import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { dropTestDatabase, resetTestDatabase } from "./test-database.js"

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
let shardUrl: string

/** Runs a query as the app role on the shard database. */
async function asApp<T extends pg.QueryResultRow>(sql: string) {
  const client = new pg.Client({ connectionString: shardUrl })
  await client.connect()
  try {
    return (await client.query<T>(sql)).rows
  } finally {
    await client.end()
  }
}

describe("the database of a test shard (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const url = new URL(process.env.DATABASE_URL)
    url.pathname = `/ctxpipe_shard_test_${suffix}`
    shardUrl = url.toString()
  })

  afterAll(async () => {
    if (shardUrl) await dropTestDatabase(shardUrl)
  })

  it("is new and migrated after each reset, and the app role can use it", async () => {
    await resetTestDatabase(shardUrl)
    await asApp(
      `INSERT INTO organizations (id, name, slug, created_at) VALUES ('org_shard_${suffix}', 'Shard', 'shard-${suffix}', now())`,
    )
    expect(
      await asApp(
        "SELECT to_regclass('openworkflow.workflow_runs')::text AS runs",
      ),
    ).toEqual([{ runs: "openworkflow.workflow_runs" }])

    await resetTestDatabase(shardUrl)
    expect(
      await asApp<{ n: number }>(
        "SELECT count(*)::int AS n FROM organizations",
      ),
    ).toEqual([{ n: 0 }])
  })

  it("is gone after a drop", async () => {
    await resetTestDatabase(shardUrl)
    await dropTestDatabase(shardUrl)
    await expect(asApp("SELECT 1")).rejects.toThrow(/does not exist/)
    // A second drop of a database that is not there passes.
    await dropTestDatabase(shardUrl)
  })

  it("refuses a URL that is not the local app role", async () => {
    const owner = new URL(shardUrl)
    owner.username = "ctxpipe"
    await expect(resetTestDatabase(owner.toString())).rejects.toThrow(
      /local Postgres/,
    )
  })
})
