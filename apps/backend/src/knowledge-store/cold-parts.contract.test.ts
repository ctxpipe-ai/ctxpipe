import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { knowledgeRowCounts, startClickHouse } from "../test/clickhouse.js"
import {
  createKnowledgeStore,
  NO_KNOWLEDGE_ROWS,
  ORG_SETTING,
} from "./knowledge-store.js"

/*
 * ADR-066 decision 10 on a real ClickHouse of the pinned image, with the
 * storage policy of clickhouse-storage.xml: a part of rows that were written
 * more than 30 days ago moves to the volume cold, and a part of new rows
 * stays on the volume hot.
 */

const tables = [
  "documents",
  "chunks",
  "relations",
  "relations_in",
  "doc_refs",
] as const

let clickHouse: Awaited<ReturnType<typeof startClickHouse>>

beforeAll(async () => {
  // The disk cold is object storage, as the S3 disk of the hosted node.
  clickHouse = await startClickHouse({
    objectStorageCold: true,
    fastPartCleanup: true,
  })
}, 240_000)

afterAll(async () => {
  await clickHouse?.stop()
})

describe("old knowledge parts", () => {
  it("move to the volume cold, and new parts stay on hot", async () => {
    const client = clickHouse.client(await clickHouse.freshDatabase())
    const orgId = "org_cold_parts"
    for (const table of tables) {
      // Two inserts: two parts in two month partitions. The new row gets
      // written_at from its DEFAULT, as a row of KnowledgeStore does.
      await client.command({
        query: `INSERT INTO ${table} (org_id, written_at)
          VALUES ({orgId:String}, now() - INTERVAL 40 DAY)`,
        query_params: { orgId },
        clickhouse_settings: { [ORG_SETTING]: orgId },
      })
      await client.command({
        query: `INSERT INTO ${table} (org_id) VALUES ({orgId:String})`,
        query_params: { orgId },
        clickhouse_settings: { [ORG_SETTING]: orgId },
      })
    }

    // The server moves parts in the background, some seconds after the TTL.
    let parts: { table: string; age: "old" | "new"; disk: string }[] = []
    for (let attempt = 0; attempt < 120; attempt++) {
      parts = await (
        await client.query({
          query: `SELECT table,
              if(max_time < now() - INTERVAL 30 DAY, 'old', 'new') AS age,
              disk_name AS disk
            FROM system.parts
            WHERE database = currentDatabase() AND active
              AND table IN {tables:Array(String)}
            ORDER BY table, age`,
          query_params: { tables },
          format: "JSONEachRow",
        })
      ).json()
      if (parts.filter((part) => part.disk === "cold").length >= tables.length)
        break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    expect(parts).toEqual(
      [...tables].sort().flatMap((table) => [
        { table, age: "new", disk: "default" },
        { table, age: "old", disk: "cold" },
      ]),
    )
  }, 120_000)

  // CTX-1672: the bytes of a purged Workspace leave the cold parts too.
  it("an erase after a purge removes the purged rows from a cold part, and the part stays on cold", async () => {
    const url = await clickHouse.freshDatabase()
    const client = clickHouse.client(url)
    const purged = { orgId: "org_cold_purged", workspaceId: "ws_cold" }
    const kept = { orgId: "org_cold_kept", workspaceId: "ws_cold" }
    for (const table of tables)
      for (const scope of [purged, kept])
        await client.command({
          query: `INSERT INTO ${table} (org_id, workspace_id, written_at)
            VALUES ({orgId:String}, {workspaceId:String}, now() - INTERVAL 40 DAY)`,
          query_params: scope,
          clickhouse_settings: { [ORG_SETTING]: scope.orgId },
        })
    const oneRow = { ...NO_KNOWLEDGE_ROWS }
    for (const table of tables) oneRow[table] = 1

    const parts = async () =>
      (
        await client.query({
          query: `SELECT table, disk_name AS disk, toUInt32(sum(rows)) AS rows
            FROM system.parts
            WHERE database = currentDatabase() AND active
              AND table IN {tables:Array(String)}
            GROUP BY table, disk ORDER BY table`,
          query_params: { tables },
          format: "JSONEachRow",
        })
      ).json<{ table: string; disk: string; rows: number }>()
    await vi.waitFor(
      async () =>
        expect(await parts()).toEqual(
          [...tables].sort().map((table) => ({ table, disk: "cold", rows: 2 })),
        ),
      { timeout: 60_000, interval: 500 },
    )

    const store = createKnowledgeStore(url)
    try {
      await store.purge(purged)
      expect(
        await knowledgeRowCounts(client, purged, { inParts: true }),
      ).toEqual(oneRow)
      // The parts of the purged org, and their objects in the object
      // storage, before the erase starts to rewrite them.
      const before: string[] = []
      for (const table of tables)
        for (const { part } of await (
          await client.query({
            query: `SELECT DISTINCT _part AS part FROM ${table}
              WHERE org_id = {orgId:String}`,
            query_params: { orgId: purged.orgId },
            format: "JSONEachRow",
            clickhouse_settings: {
              [ORG_SETTING]: purged.orgId,
              apply_deleted_mask: 0,
            },
          })
        ).json<{ part: string }>())
          before.push(`${table}/${part}`)
      const objects = (
        await (
          await client.query({
            query: `SELECT remote_path AS object
              FROM system.remote_data_paths AS paths
              JOIN system.tables AS tables
                ON paths.local_path LIKE concat('%', toString(tables.uuid), '/%')
              WHERE paths.disk_name = 'cold'
                AND tables.database = currentDatabase()
                AND concat(tables.name, '/', splitByChar('/', paths.local_path)[4])
                  IN {before:Array(String)}`,
            query_params: { before },
            format: "JSONEachRow",
          })
        ).json<{ object: string }>()
      ).map((row) => row.object)
      expect(objects.length).toBeGreaterThan(tables.length)
      for (const object of objects)
        expect(await clickHouse.fileExists(object), object).toBe(true)

      // Each table has one part of the purged org.
      const erased = await store.findPurgedParts(purged)
      expect(
        erased.map(({ table, part }) => `${table}/${part}`).sort(),
      ).toEqual(before.sort())
      expect(erased.map(({ table }) => table).sort()).toEqual(
        [...tables].sort(),
      )
      expect(await store.erasePurged(purged)).toBe(tables.length)
      await vi.waitFor(
        async () => expect(await store.purgedRowsInParts(purged)).toBe(0),
        { timeout: 30_000, interval: 200 },
      )
      // The server removes the parts that held the purged rows from the
      // disk, and so their objects from the object storage.
      await vi.waitFor(
        async () => expect(await store.partsLeft(erased)).toBe(0),
        { timeout: 120_000, interval: 1_000 },
      )
      for (const object of objects)
        expect(await clickHouse.fileExists(object), object).toBe(false)
    } finally {
      await store.close()
    }

    expect(await knowledgeRowCounts(client, purged, { inParts: true })).toEqual(
      NO_KNOWLEDGE_ROWS,
    )
    expect(await knowledgeRowCounts(client, kept)).toEqual(oneRow)
    expect(await parts()).toEqual(
      [...tables].sort().map((table) => ({ table, disk: "cold", rows: 1 })),
    )
  }, 240_000)
})
