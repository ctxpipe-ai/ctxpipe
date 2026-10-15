import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { migrateOpenWorkflow } from "./migrate-openworkflow.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const migrationSql = readFileSync(
  join(
    __dirname,
    "../../migrations/20261016090000_retire_link_unlink_runs/migration.sql",
  ),
  "utf8",
)
const database = `ctxpipe_test_retire_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

let admin: pg.Client
let db: pg.Client
let databaseUrl: string

async function runMigration() {
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.query(statement)
  }
}

async function insertRun(id: string, workflowName: string, status: string) {
  await db.query(
    `INSERT INTO "openworkflow"."workflow_runs"
      ("namespace_id", "id", "workflow_name", "status", "attempts", "available_at", "created_at", "updated_at")
     VALUES ('default', $1, $2, $3, 0, now(), now(), now())`,
    [id, workflowName, status],
  )
}

describe("retire link-unlink runs migration (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    const ownerUrl = new URL(ownerUrlForMigrate(process.env.DATABASE_URL))
    admin = new pg.Client({ connectionString: ownerUrl.toString() })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${database}"`)
    ownerUrl.pathname = `/${database}`
    databaseUrl = ownerUrl.toString()
    db = new pg.Client({ connectionString: databaseUrl })
    await db.connect()
  }, 60_000)

  afterAll(async () => {
    await db?.end()
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin?.end()
  })

  it("runs on a database without the OpenWorkflow schema", async () => {
    await db.query(`CREATE TABLE "workspace_write_jobs" (
      "id" text primary key, "kind" text not null, "status" text not null,
      "payload" jsonb, "updated_at" timestamptz not null default now())`)
    await runMigration()
  })

  it("cancels open runs and fails open jobs of the retired kind only", async () => {
    await migrateOpenWorkflow(databaseUrl)
    await insertRun("run_pending", "workspace-write-link-unlink", "pending")
    await insertRun("run_sleeping", "workspace-write-link-unlink", "sleeping")
    await insertRun("run_done", "workspace-write-link-unlink", "completed")
    await insertRun("run_other", "workspace-write-bootstrap", "pending")
    await db.query(
      `INSERT INTO "workspace_write_jobs" ("id", "kind", "status", "payload") VALUES
        ('job_open', 'link_unlink', 'queued', '{"jobWorkspaceUrl": "https://example.test/docs"}'),
        ('job_paused', 'link_unlink', 'paused', null),
        ('job_done', 'link_unlink', 'completed', null),
        ('job_other', 'bootstrap', 'queued', null)`,
    )

    await runMigration()

    const runs = await db.query<{ id: string; status: string }>(
      `SELECT "id", "status" FROM "openworkflow"."workflow_runs" ORDER BY "id"`,
    )
    expect(runs.rows).toEqual([
      { id: "run_done", status: "completed" },
      { id: "run_other", status: "pending" },
      { id: "run_pending", status: "canceled" },
      { id: "run_sleeping", status: "canceled" },
    ])
    const jobs = await db.query<{
      id: string
      status: string
      payload: { failureReason?: string; jobWorkspaceUrl?: string } | null
    }>(
      `SELECT "id", "status", "payload" FROM "workspace_write_jobs" ORDER BY "id"`,
    )
    const byId = new Map(jobs.rows.map((row) => [row.id, row]))
    expect(byId.get("job_open")?.status).toBe("failed")
    expect(byId.get("job_open")?.payload?.jobWorkspaceUrl).toBe(
      "https://example.test/docs",
    )
    expect(byId.get("job_open")?.payload?.failureReason).toContain("retired")
    expect(byId.get("job_paused")?.status).toBe("failed")
    expect(byId.get("job_done")?.status).toBe("completed")
    expect(byId.get("job_other")?.status).toBe("queued")
  }, 60_000)
})
