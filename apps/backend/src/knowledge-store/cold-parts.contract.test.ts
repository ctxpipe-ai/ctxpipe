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
  clickHouse = await startClickHouse()
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

    // The server keeps an old part for 8 minutes after a mutation replaced
    // it. A test cannot wait that long.
    for (const table of tables)
      await client.command({
        query: `ALTER TABLE ${table} MODIFY SETTING old_parts_lifetime = 1`,
      })

    const store = createKnowledgeStore(url)
    try {
      await store.purge(purged)
      expect(
        await knowledgeRowCounts(client, purged, { inParts: true }),
      ).toEqual(oneRow)
      expect(await store.erasePurged(purged)).toBe(tables.length)
      await vi.waitFor(
        async () => expect(await store.purgedRowsInParts(purged)).toBe(0),
        { timeout: 30_000, interval: 200 },
      )
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
    // The server removes the old parts, which held the purged rows, from
    // the disk. An old part with no rows (the empty result of the erase of
    // a part of only purged rows) can stay longer: it holds no bytes of a
    // row.
    await vi.waitFor(
      async () => {
        const result = await client.query({
          query: `SELECT toUInt32(count()) AS parts FROM system.parts
            WHERE database = currentDatabase() AND NOT active AND rows > 0
              AND table IN {tables:Array(String)}`,
          query_params: { tables },
          format: "JSONEachRow",
        })
        expect(await result.json()).toEqual([{ parts: 0 }])
      },
      { timeout: 120_000, interval: 1_000 },
    )
  }, 240_000)
})
