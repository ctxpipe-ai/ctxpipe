import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ownerUrlForMigrate } from "./owner-migrate-url.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const migrationsDir = join(__dirname, "../../migrations")
const target = "20261024091038_delete_workspace_checkout_rows"
const database = `ctxpipe_test_ws_rows_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

let admin: pg.Client
let db: pg.Client

async function apply(names: string[]) {
  for (const name of names) {
    const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8")
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.query(statement)
    }
  }
}

async function checkoutKeys(): Promise<string[]> {
  const { rows } = await db.query<{ checkout_key: string }>(
    `SELECT "checkout_key" FROM "repository_checkouts" ORDER BY "checkout_key"`,
  )
  return rows.map((row) => row.checkout_key)
}

describe("delete Workspace checkout rows migration (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const ownerUrl = new URL(ownerUrlForMigrate(process.env.DATABASE_URL))
    admin = new pg.Client({ connectionString: ownerUrl.toString() })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${database}"`)
    ownerUrl.pathname = `/${database}`
    db = new pg.Client({ connectionString: ownerUrl.toString() })
    // DROP DATABASE ... WITH (FORCE) in afterAll can end a socket that
    // db.end() has not closed yet. An "error" event with no listener throws.
    db.on("error", (error) => console.warn("Client error at teardown", error))
    await db.connect()
  }, 60_000)

  afterAll(async () => {
    await db?.end()
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin?.end()
  })

  it("deletes only the ws: rows, and a second run and an empty table are safe", async () => {
    await apply(migrations.filter((name) => name < target))
    const orgId = "org_ws_rows"
    const sha = "a".repeat(40)
    await db.query(
      `INSERT INTO "organizations" ("id", "name", "slug", "created_at") VALUES ($1, 'Acme', 'acme-ws-rows', now())`,
      [orgId],
    )
    await db.query(
      `INSERT INTO "repositories" ("id", "org_id", "name", "git_url", "created_at") VALUES ('repo_app', $1, 'app', 'https://github.com/acme/app.git', now())`,
      [orgId],
    )
    await db.query(
      `INSERT INTO "repository_checkouts" ("id", "org_id", "repository_id", "checkout_key") VALUES
        ('chk_default', $1, 'repo_app', 'default'),
        ('chk_rev', $1, 'repo_app', $2),
        ('chk_ws', $1, 'repo_app', 'ws:ws_one'),
        ('chk_ws_sha', $1, 'repo_app', $3),
        ('chk_wsx', $1, 'repo_app', 'wsx')`,
      [orgId, `rev:${sha}`, `ws:ws_one:${sha}`],
    )

    await apply([target])
    expect(await checkoutKeys()).toEqual(["default", `rev:${sha}`, "wsx"])

    await apply([target])
    expect(await checkoutKeys()).toEqual(["default", `rev:${sha}`, "wsx"])

    await db.query(`DELETE FROM "repository_checkouts"`)
    await apply([target])
    expect(await checkoutKeys()).toEqual([])

    await apply(migrations.filter((name) => name > target))
  })
})
