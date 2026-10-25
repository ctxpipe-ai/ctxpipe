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
const unverified = "20261025060017_two_factor_unfinished_unverified"
const stranded = "20261025070554_two_factor_stranded_disabled"
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

let admin: pg.Client
let db: pg.Client
const databases: string[] = []
const clients: pg.Client[] = []

async function apply(names: string[]) {
  for (const name of names) {
    const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8")
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.query(statement)
    }
  }
}

async function connect(name?: string): Promise<pg.Client> {
  const url = new URL(ownerUrlForMigrate(process.env.DATABASE_URL as string))
  if (name) url.pathname = `/${name}`
  const client = new pg.Client({ connectionString: url.toString() })
  // DROP DATABASE ... WITH (FORCE) in afterAll can end a socket that
  // client.end() has not closed yet. An "error" event with no listener throws.
  client.on("error", (error) => console.warn("Client error at teardown", error))
  await client.connect()
  clients.push(client)
  return client
}

async function createScratchDatabase() {
  const database = `ctxpipe_test_two_factor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  databases.push(database)
  await admin.query(`CREATE DATABASE "${database}"`)
  db = await connect(database)
}

async function insertUsers(rows: Array<[string, boolean | null]>) {
  for (const [id, enabled] of rows) {
    await db.query(
      `INSERT INTO "users" ("id", "name", "email", "two_factor_enabled") VALUES ($1, $1, $2, $3)`,
      [id, `${id}@example.com`, enabled],
    )
  }
}

describe("two-factor migrations (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    admin = await connect()
  }, 60_000)

  afterAll(async () => {
    for (const client of clients) if (client !== admin) await client.end()
    for (const database of databases) {
      await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    }
    await admin?.end()
  })

  it("marks an unfinished factor as unverified and keeps a finished one verified", async () => {
    await createScratchDatabase()
    await apply(migrations.filter((name) => name < columns))
    await insertUsers([
      ["abandoned", false],
      ["unset", null],
      ["finished", true],
    ])
    await db.query(
      `INSERT INTO "two_factors" ("id", "secret", "backup_codes", "user_id") VALUES
        ('f1', 's', 'b', 'abandoned'), ('f2', 's', 'b', 'unset'), ('f3', 's', 'b', 'finished')`,
    )

    await apply([columns, unverified])

    const { rows } = await db.query(
      `SELECT "user_id", "verified" FROM "two_factors" ORDER BY "user_id"`,
    )
    expect(rows).toEqual([
      { user_id: "abandoned", verified: false },
      { user_id: "finished", verified: true },
      { user_id: "unset", verified: false },
    ])
  })

  it("turns two-factor off for a user with no factor row and keeps it on for a user with a row", async () => {
    await createScratchDatabase()
    await apply(migrations.filter((name) => name < stranded))
    await insertUsers([
      ["stranded", true],
      ["finished", true],
      ["off", false],
    ])
    await db.query(
      `INSERT INTO "two_factors" ("id", "secret", "backup_codes", "user_id") VALUES ('f1', 's', 'b', 'finished')`,
    )

    await apply([stranded])

    const { rows } = await db.query(
      `SELECT "id", "two_factor_enabled" FROM "users" ORDER BY "id"`,
    )
    expect(rows).toEqual([
      { id: "finished", two_factor_enabled: true },
      { id: "off", two_factor_enabled: false },
      { id: "stranded", two_factor_enabled: false },
    ])
  })
})
