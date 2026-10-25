import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ownerUrlForMigrate } from "./owner-migrate-url.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })

const migrationsDir = join(__dirname, "../../migrations")
const columns = "20261025060007_two_factor_lockout_columns"
const database = `ctxpipe_test_two_factor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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

describe("two-factor data migration (Postgres)", () => {
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

  it("marks an unfinished factor unverified and turns two-factor off for a user with no factor, and keeps a working factor", async () => {
    await apply(migrations.filter((name) => name < columns))
    for (const [id, enabled] of [
      ["abandoned", false],
      ["unset", null],
      ["finished", true],
      ["stranded", true],
    ] as const) {
      await db.query(
        `INSERT INTO "users" ("id", "name", "email", "two_factor_enabled") VALUES ($1, $1, $2, $3)`,
        [id, `${id}@example.com`, enabled],
      )
    }
    await db.query(
      `INSERT INTO "two_factors" ("id", "secret", "backup_codes", "user_id") VALUES
        ('f1', 's', 'b', 'abandoned'), ('f2', 's', 'b', 'unset'), ('f3', 's', 'b', 'finished')`,
    )

    await apply(migrations.filter((name) => name >= columns))

    const factors = await db.query(
      `SELECT "user_id", "verified" FROM "two_factors" ORDER BY "user_id"`,
    )
    expect(factors.rows).toEqual([
      { user_id: "abandoned", verified: false },
      { user_id: "finished", verified: true },
      { user_id: "unset", verified: false },
    ])
    const users = await db.query(
      `SELECT "id", "two_factor_enabled" FROM "users" ORDER BY "id"`,
    )
    expect(users.rows).toEqual([
      { id: "abandoned", two_factor_enabled: false },
      { id: "finished", two_factor_enabled: true },
      { id: "stranded", two_factor_enabled: false },
      { id: "unset", two_factor_enabled: null },
    ])
  })
})
