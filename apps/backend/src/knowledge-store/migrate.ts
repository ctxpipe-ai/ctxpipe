import { createHash, randomBytes } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"

import type { ClickHouseClient } from "@clickhouse/client"

import { log } from "../observability/logger.js"
import { createClickHouseClient } from "./knowledge-store.js"

/**
 * The passwords of the two ClickHouse users that the migration makes. If a
 * password is not set, the migration does not make or change that user. A
 * user that does not exist cannot connect, so a missing password fails
 * closed. A password that is the same as the password of the admin user in
 * `url` is refused.
 */
type KnowledgeUserPasswords = {
  /** The user of the backend (`ctxpipe_reader`): SELECT only. */
  reader?: string
  /**
   * The user of the worker (`ctxpipe_writer`): SELECT, INSERT and ALTER
   * DELETE. KnowledgeStore never runs an UPDATE (ADR-066 decision 8).
   */
  writer?: string
}

/**
 * Applies the ClickHouse SQL files of `migrations/` in name order, each one
 * time. The table `knowledge_schema_migrations` records the applied files.
 * A file holds statements that each end with `;` at the end of a line.
 * Write each statement so that a second run changes nothing (`IF NOT EXISTS`,
 * `OR REPLACE`): a run that fails part way applies the whole file again.
 */
export async function migrateKnowledgeStore(
  url: string,
  passwords: KnowledgeUserPasswords = {},
): Promise<void> {
  const adminPassword = decodeURIComponent(new URL(url).password)
  for (const password of [passwords.reader, passwords.writer])
    if (password && password === adminPassword)
      throw new Error(
        "[migrate] The ClickHouse reader and writer passwords must be different from the admin password",
      )
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
    await setUser(client, "ctxpipe_reader", passwords.reader, "SELECT")
    await setUser(
      client,
      "ctxpipe_writer",
      passwords.writer,
      "SELECT, INSERT, ALTER DELETE",
    )
  } finally {
    await client.close()
  }
}

/**
 * Makes the user `name`, or sets its password, and gives it `privileges` on
 * the knowledge tables of the current database, and nothing more (ADR-066
 * decision 9). The user gets no access management, so it cannot drop a row
 * policy or a constraint. The row policies are `TO ALL`, so they also apply
 * to this user.
 */
async function setUser(
  client: ClickHouseClient,
  name: string,
  password: string | undefined,
  privileges: string,
): Promise<void> {
  if (!password) {
    log.info({
      step: "migrate",
      message: "[migrate] no password for a ClickHouse user: it is not changed",
      user: name,
    })
    return
  }
  // The statement holds a SHA-256 hash in hex, not the password: nothing
  // from the setting gets into the SQL text or the query log.
  const salt = randomBytes(16).toString("hex")
  const hash = createHash("sha256")
    .update(password + salt)
    .digest("hex")
  const identified = `IDENTIFIED WITH sha256_hash BY '${hash}' SALT '${salt}'`
  await client.command({
    query: `CREATE USER IF NOT EXISTS ${name} ${identified}`,
  })
  await client.command({ query: `ALTER USER ${name} ${identified}` })
  // WITH REPLACE OPTION removes each grant that is not in this statement.
  await client.command({
    query: `GRANT ${["documents", "chunks", "relations", "relations_in"]
      .map((table) => `${privileges} ON ${table}`)
      .join(", ")} TO ${name} WITH REPLACE OPTION`,
  })
  log.info({
    step: "migrate",
    message: "[migrate] set a ClickHouse user and its grants",
    user: name,
  })
}
