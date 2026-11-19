import { readdir, readFile } from "node:fs/promises"

import { log } from "../observability/logger.js"
import { createClickHouseClient } from "./knowledge-store.js"

/**
 * Applies the ClickHouse SQL files of `migrations/` in name order, each one
 * time. The table `knowledge_schema_migrations` records the applied files.
 * A file holds statements that each end with `;` at the end of a line.
 * Write each statement so that a second run changes nothing (`IF NOT EXISTS`,
 * `OR REPLACE`): a run that fails part way applies the whole file again.
 */
export async function migrateKnowledgeStore(url: string): Promise<void> {
  const migrationsFolder = new URL("./migrations/", import.meta.url)
  const client = createClickHouseClient(url)
  try {
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS knowledge_schema_migrations
        (name String, applied_at DateTime64(3, 'UTC') DEFAULT now64(3))
        ENGINE = MergeTree ORDER BY name`,
    })
    const applied = new Set(
      (
        await (
          await client.query({
            query: "SELECT name FROM knowledge_schema_migrations",
            format: "JSONEachRow",
          })
        ).json<{ name: string }>()
      ).map((row) => row.name),
    )
    const files = (await readdir(migrationsFolder))
      .filter((name) => name.endsWith(".sql"))
      .sort()
    for (const name of files) {
      if (applied.has(name)) continue
      const sql = await readFile(new URL(name, migrationsFolder), "utf8")
      for (const statement of sql.split(/;[ \t]*$/m)) {
        const code = statement
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .trim()
        if (code) await client.command({ query: code })
      }
      await client.insert({
        table: "knowledge_schema_migrations",
        values: [{ name }],
        format: "JSONEachRow",
        columns: ["name"],
        clickhouse_settings: { async_insert: 0 },
      })
      log.info({
        step: "migrate",
        message: "[migrate] applied a ClickHouse migration",
        migration: name,
      })
    }
  } finally {
    await client.close()
  }
}
