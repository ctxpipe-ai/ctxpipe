import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { startClickHouse } from "../test/clickhouse.js"
import { ORG_SETTING } from "./knowledge-store.js"

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
})
