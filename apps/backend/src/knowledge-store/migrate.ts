import { readdir, readFile } from "node:fs/promises"

import { ClickHouseLogLevel, createClient } from "@clickhouse/client"

import { log } from "../observability/logger.js"

/**
 * Applies the ClickHouse SQL files of `migrations/` in name order, each one
 * time. The table `knowledge_schema_migrations` records the applied files.
 * A file holds statements that each end with `;` at the end of a line.
 * Write each statement so that a second run changes nothing (`IF NOT EXISTS`,
 * `OR REPLACE`): a run that fails part way applies the whole file again.
 * Returns the names of the files that this run applied.
 */
export async function migrateKnowledgeStore(url: string): Promise<string[]> {
  const migrationsFolder = new URL("./migrations/", import.meta.url)
  // The client logs to the console. Each error goes to the caller instead.
  const client = createClient({ url, log: { level: ClickHouseLogLevel.OFF } })
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
    const ran: string[] = []
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
      ran.push(name)
    }
    return ran
  } finally {
    await client.close()
  }
}
