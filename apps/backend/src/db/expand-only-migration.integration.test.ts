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
import { backfillNullOrgIds } from "./backfill-null-org-ids.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const migrationsDir = join(__dirname, "../../migrations")
const database = `ctxpipe_test_expand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
/** The migrations on `origin/main`: the database of the previous release. */
const mainMigrations = [
  "20260215123220_sudden_pepper_potts",
  "20260215130618_long_riptide",
  "20260215130918_fast_living_mummy",
  "20260216001306_drop_slug_repositories",
  "20260218120500_add_index_ready_repositories",
  "20260221110000_code_ingestion_queue",
  "20260226103322_clean_lyja",
  "20260308050145_far_changeling",
  "20260308050858_naive_lightspeed",
  "20260309101414_pretty_squadron_supreme",
  "20260310062538_lyrical_sunset_bain",
  "20260311040618_bright_stryfe",
  "20260315013002_acoustic_the_hand",
  "20260315120000_retrieval_search_fts_index",
  "20260323115738_overjoyed_wraith",
  "20260327094211_whole_smasher",
  "20260402034841_closed_spencer_smythe",
  "20260403030439_clever_loki",
  "20260404042644_medical_magus",
  "20260409004435_outgoing_lightspeed",
  "20260414134946_dry_grandmaster",
  "20260415111347_pink_white_queen",
  "20260417122539_funny_scarlet_spider",
  "20260420074446_warm_mad_thinker",
  "20260427095743_smart_nextwave",
  "20260428115957_sharp_gressill",
  "20260613135611_lyrical_cardiac",
  "20260709050736_remarkable_ben_urich",
  "20260709131534_bent_blazing_skull",
  "20260726120909_reflective_madelyne_pryor",
  "20260728140749_t08_enqueue_scip_migration_workflows",
  "20260802135614_messy_maestro",
  "20260818080007_complete_with_issues",
  "20260819074836_old_gamora",
  "20260826094232_minor_yellowjacket",
]

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

/** Run `work` as the app role, in a transaction scoped to `orgId`. */
async function asApp<T>(
  orgId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SET LOCAL ROLE ctxpipe_app")
    await client.query("SELECT set_config('app.organization_id', $1, true)", [
      orgId,
    ])
    const result = await work(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

async function appIds(orgId: string, table: string) {
  return asApp(orgId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT "id" FROM "${table}" ORDER BY "id"`,
    )
    return rows.map((row) => row.id)
  })
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
    // pool.end() resolves before the sockets close. DROP DATABASE ... WITH
    // (FORCE) then ends them, and the pool re-emits that FATAL 57P01 as an
    // "error" event of the pool itself. With no pool listener, Node throws it
    // as an uncaught exception.
    pool.on("error", (error) => console.warn("Pool error at teardown", error))
    scratch = mkdtempSync(join(tmpdir(), "ctxpipe-expand-only-"))
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin?.end()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it("upgrades a main database: deletes orphan rows only on commit, keeps LangGraph tables, and fills org_id on rows the previous image writes", async () => {
    const db = drizzle({ client: pool })
    await migrate(db, {
      migrationsFolder: migrationsFolder("before", mainMigrations),
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
    const { rows: applied } = await pool.query<{ name: string }>(
      `SELECT "name" FROM "drizzle"."__drizzle_migrations" ORDER BY "name"`,
    )
    expect(applied.map((row) => row.name)).toEqual(mainMigrations)
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

    await pool.query(`GRANT USAGE ON SCHEMA "public" TO ctxpipe_app`)
    await pool.query(
      `GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA "public" TO ctxpipe_app`,
    )
    await pool.query(
      `GRANT USAGE ON ALL SEQUENCES IN SCHEMA "public" TO ctxpipe_app`,
    )

    // A rollback: the previous image writes rows with no org_id on the owner URL.
    // The trigger copies org_id from the parent, so the app role sees the rows.
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
    expect(await appIds(orgId, "repository_checkouts")).toEqual([
      "checkout_kept",
      "checkout_rollback",
    ])
    expect(await appIds(orgId, "confluence_spaces")).toEqual([
      "space_kept",
      "space_rollback",
    ])
    expect(await appIds(orgId, "claim_evidence")).toEqual([
      "evidence_kept",
      "evidence_rollback",
    ])

    // Rows with no org_id that the trigger did not fill: RLS hides them from the
    // app role until the backfill on the next migrate repairs them.
    const owner = await pool.connect()
    try {
      await owner.query("SET session_replication_role = replica")
      await owner.query(
        `INSERT INTO "repository_checkouts" ("id", "repository_id", "checkout_key") VALUES ('checkout_hidden', 'repo_kept', 'hidden')`,
      )
      await owner.query(
        `INSERT INTO "confluence_spaces" ("id", "connection_id", "space_key") VALUES ('space_hidden', 'con_kept', 'HID')`,
      )
      await owner.query(
        `INSERT INTO "claim_evidence" ("id", "claim_id", "source_type", "source_id", "extraction_method", "confidence", "observed_at")
         VALUES ('evidence_hidden', 'claim_kept', 'repo', 'repo_kept', 'llm', 1, now())`,
      )
    } finally {
      await owner.query("SET session_replication_role = origin")
      owner.release()
    }
    expect(await appIds(orgId, "repository_checkouts")).not.toContain(
      "checkout_hidden",
    )
    expect(await appIds(orgId, "confluence_spaces")).not.toContain(
      "space_hidden",
    )
    expect(await appIds(orgId, "claim_evidence")).not.toContain(
      "evidence_hidden",
    )
    await backfillNullOrgIds(pool)
    await backfillNullOrgIds(pool)
    expect(await appIds(orgId, "repository_checkouts")).toContain(
      "checkout_hidden",
    )
    expect(await appIds(orgId, "confluence_spaces")).toContain("space_hidden")
    expect(await appIds(orgId, "claim_evidence")).toContain("evidence_hidden")

    // The app role inserts a row with no org_id: the trigger fills it from a parent
    // in the same org. A parent in another org is hidden, so RLS rejects the row.
    await asApp(orgId, (client) =>
      client.query(
        `INSERT INTO "repository_checkouts" ("id", "repository_id", "checkout_key") VALUES ('checkout_app', 'repo_kept', 'app')`,
      ),
    )
    expect(
      (await orgRows("repository_checkouts")).find(
        (row) => row.id === "checkout_app",
      ),
    ).toEqual({ id: "checkout_app", orgId })
    await expect(
      asApp("org_other", (client) =>
        client.query(
          `INSERT INTO "repository_checkouts" ("id", "repository_id", "checkout_key") VALUES ('checkout_cross', 'repo_kept', 'cross')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  }, 180_000)
})
