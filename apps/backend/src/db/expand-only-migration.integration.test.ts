import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const migrationsDir = join(__dirname, "../../migrations")
const orgScopedMigration = "20260821051216_chunky_shocker"
const database = `ctxpipe_test_expand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

let admin: pg.Client
let pool: pg.Pool
let scratch: string

/** A migrations folder with the given real migrations and optional extra ones. */
function migrationsFolder(
  name: string,
  folders: string[],
  extra: Record<string, string> = {},
) {
  const folder = join(scratch, name)
  mkdirSync(folder)
  for (const entry of folders) {
    symlinkSync(join(migrationsDir, entry), join(folder, entry))
  }
  for (const [entry, sql] of Object.entries(extra)) {
    mkdirSync(join(folder, entry))
    writeFileSync(join(folder, entry, "migration.sql"), sql)
  }
  return folder
}

async function ids(table: string) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT "id" FROM "${table}" ORDER BY "id"`,
  )
  return rows.map((row) => row.id)
}

async function orgRows(table: string) {
  const { rows } = await pool.query<{ id: string; orgId: string | null }>(
    `SELECT "id", "org_id" AS "orgId" FROM "${table}" ORDER BY "id"`,
  )
  return rows
}

describe("expand-only SQL migrations from a main database (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const ownerUrl = new URL(ownerUrlForMigrate(process.env.DATABASE_URL))
    admin = new pg.Client({ connectionString: ownerUrl.toString() })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${database}"`)
    ownerUrl.pathname = `/${database}`
    pool = new pg.Pool({ connectionString: ownerUrl.toString() })
    scratch = mkdtempSync(join(tmpdir(), "ctxpipe-expand-only-"))
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin?.end()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it("deletes orphan rows only when the migration commits, keeps LangGraph tables, and lets the previous image write", async () => {
    const db = drizzle({ client: pool })
    await migrate(db, {
      migrationsFolder: migrationsFolder(
        "before",
        migrations.filter((name) => name < orgScopedMigration),
      ),
    })

    const orgId = "org_expand_only"
    await pool.query(
      `INSERT INTO "organizations" ("id", "name", "slug", "created_at") VALUES ($1, 'Acme', 'acme-expand', now())`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO "repositories" ("id", "org_id", "name", "git_url") VALUES ('repo_kept', $1, 'kept', 'https://github.com/acme/kept')`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO "connections" ("id", "org_id", "type", "config") VALUES ('con_kept', $1, 'forge', '{}')`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO "claims" ("id", "org_id", "subject_id", "predicate", "object_id", "status", "first_observed_at", "last_observed_at", "aggregated_confidence")
       VALUES ('claim_kept', $1, 'obj_a', 'uses', 'obj_b', 'active', now(), now(), 1)`,
      [orgId],
    )
    await pool.query(
      `INSERT INTO "repository_checkouts" ("id", "repository_id", "checkout_key") VALUES ('checkout_kept', 'repo_kept', 'main')`,
    )
    await pool.query(
      `INSERT INTO "confluence_spaces" ("id", "connection_id", "space_key") VALUES ('space_kept', 'con_kept', 'ENG')`,
    )
    await pool.query(
      `INSERT INTO "claim_evidence" ("id", "claim_id", "source_type", "source_id", "extraction_method", "confidence", "observed_at")
       VALUES ('evidence_kept', 'claim_kept', 'repo', 'repo_kept', 'llm', 1, now())`,
    )
    // Orphan rows: a parent row that no longer exists, so the migration finds no org.
    const client = await pool.connect()
    try {
      await client.query("SET session_replication_role = replica")
      await client.query(
        `INSERT INTO "repository_checkouts" ("id", "repository_id", "checkout_key") VALUES ('checkout_orphan', 'repo_gone', 'main')`,
      )
      await client.query(
        `INSERT INTO "confluence_spaces" ("id", "connection_id", "space_key") VALUES ('space_orphan', 'con_gone', 'OPS')`,
      )
      await client.query(
        `INSERT INTO "claim_evidence" ("id", "claim_id", "source_type", "source_id", "extraction_method", "confidence", "observed_at")
         VALUES ('evidence_orphan', 'claim_gone', 'repo', 'repo_gone', 'llm', 1, now())`,
      )
    } finally {
      await client.query("SET session_replication_role = origin")
      client.release()
    }
    // A main database holds the LangGraph checkpoint tables that main chat writes.
    await pool.query(
      `CREATE TABLE "checkpoints" ("thread_id" text NOT NULL, "checkpoint_id" text NOT NULL, PRIMARY KEY ("thread_id", "checkpoint_id"))`,
    )
    await pool.query(
      `INSERT INTO "checkpoints" VALUES ('conv_main', 'checkpoint_main')`,
    )

    // A later migration in the same run fails: the orphan DELETE rolls back.
    await expect(
      migrate(db, {
        migrationsFolder: migrationsFolder("failing", migrations, {
          "29991231235959_fail": "SELECT 1 / 0;",
        }),
      }),
    ).rejects.toThrow()
    const { rows: applied } = await pool.query(
      `SELECT "name" FROM "drizzle"."__drizzle_migrations" WHERE "name" >= $1`,
      [orgScopedMigration],
    )
    expect(applied).toEqual([])
    expect(await ids("repository_checkouts")).toEqual([
      "checkout_kept",
      "checkout_orphan",
    ])
    expect(await ids("confluence_spaces")).toEqual([
      "space_kept",
      "space_orphan",
    ])
    expect(await ids("claim_evidence")).toEqual([
      "evidence_kept",
      "evidence_orphan",
    ])

    await migrate(db, { migrationsFolder: migrationsDir })

    expect(await orgRows("repository_checkouts")).toEqual([
      { id: "checkout_kept", orgId },
    ])
    expect(await orgRows("confluence_spaces")).toEqual([
      { id: "space_kept", orgId },
    ])
    expect(await orgRows("claim_evidence")).toEqual([
      { id: "evidence_kept", orgId },
    ])
    const { rows: checkpoints } = await pool.query(
      `SELECT "thread_id" AS "threadId" FROM "checkpoints"`,
    )
    expect(checkpoints).toEqual([{ threadId: "conv_main" }])

    // The previous image writes these rows with no org_id on the owner URL.
    await pool.query(
      `INSERT INTO "repository_checkouts" ("id", "repository_id", "checkout_key") VALUES ('checkout_rollback', 'repo_kept', 'release')`,
    )
    await pool.query(
      `INSERT INTO "confluence_spaces" ("id", "connection_id", "space_key") VALUES ('space_rollback', 'con_kept', 'DOCS')`,
    )
    await pool.query(
      `INSERT INTO "claim_evidence" ("id", "claim_id", "source_type", "source_id", "extraction_method", "confidence", "observed_at")
       VALUES ('evidence_rollback', 'claim_kept', 'repo', 'repo_kept', 'llm', 1, now())`,
    )
    const { rows: written } = await pool.query(
      `SELECT count(*)::int AS "count" FROM "repository_checkouts" WHERE "repository_id" = 'repo_kept'`,
    )
    expect(written).toEqual([{ count: 2 }])
  }, 180_000)
})
