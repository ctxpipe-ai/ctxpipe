import { spawnSync } from "node:child_process"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { dropTestDatabase, resetTestDatabase } from "./test-database.js"

const base = `ctxpipe_shard_test_${Date.now()}x${Math.random().toString(36).slice(2, 8)}`
// The pid of a process that has ended: a runner that a stop ended before
// its drop.
const ended = spawnSync(process.execPath, ["-e", ""]).pid
const urls: string[] = []

/** The app-role URL of the shard database `<base>_<pid>_<shard>`. */
function shardUrl(pid: number, shard: number): string {
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.pathname = `/${base}_${pid}_${shard}`
  urls.push(url.toString())
  return url.toString()
}

/** Runs a query as the app role on a shard database. */
async function asApp<T extends pg.QueryResultRow>(url: string, sql: string) {
  const client = new pg.Client({ connectionString: url })
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
  })

  afterAll(async () => {
    for (const url of urls) await dropTestDatabase(url)
  })

  it("is new and migrated after each reset, and the app role can use it", async () => {
    const url = shardUrl(process.pid, 1)
    await resetTestDatabase(url)
    await asApp(
      url,
      `INSERT INTO organizations (id, name, slug, created_at) VALUES ('org_${base}', 'Shard', '${base}', now())`,
    )
    expect(
      await asApp(
        url,
        "SELECT to_regclass('openworkflow.workflow_runs')::text AS runs",
      ),
    ).toEqual([{ runs: "openworkflow.workflow_runs" }])

    await resetTestDatabase(url)
    expect(
      await asApp<{ n: number }>(
        url,
        "SELECT count(*)::int AS n FROM organizations",
      ),
    ).toEqual([{ n: 0 }])
  })

  it("drops the shard databases of an ended runner, and keeps those of a running one", async () => {
    const other = shardUrl(process.pid, 2)
    const left = shardUrl(ended, 1)
    await resetTestDatabase(other)
    await resetTestDatabase(left)

    await resetTestDatabase(shardUrl(process.pid, 3))
    await expect(asApp(left, "SELECT 1")).rejects.toThrow(/does not exist/)
    expect(await asApp(other, "SELECT 1 AS one")).toEqual([{ one: 1 }])
  })

  it("is gone after a drop", async () => {
    const url = shardUrl(process.pid, 4)
    await resetTestDatabase(url)
    await dropTestDatabase(url)
    await expect(asApp(url, "SELECT 1")).rejects.toThrow(/does not exist/)
    // A second drop of a database that is not there passes.
    await dropTestDatabase(url)
  })

  it("refuses a URL that is not the local app role", async () => {
    const owner = new URL(shardUrl(process.pid, 5))
    owner.username = "ctxpipe"
    await expect(resetTestDatabase(owner.toString())).rejects.toThrow(
      /local Postgres/,
    )
  })
})
