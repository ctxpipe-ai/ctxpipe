import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { migrateOpenWorkflow } from "./migrate-openworkflow.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const migrationsDir = join(__dirname, "../../migrations")
const target = "20261110005640_clear_write_step_outputs"
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

let admin: pg.Client
let adminUrl: string
const databases: string[] = []
const clients: pg.Client[] = []

async function freshDatabase(name: string) {
  const ownerUrl = new URL(adminUrl)
  const database = `ctxpipe_test_${name}_${suffix}`
  await admin.query(`CREATE DATABASE "${database}"`)
  databases.push(database)
  ownerUrl.pathname = `/${database}`
  const db = new pg.Client({ connectionString: ownerUrl.toString() })
  // DROP DATABASE ... WITH (FORCE) in afterAll can end a socket that
  // db.end() has not closed yet. An "error" event with no listener throws.
  db.on("error", (error) => console.warn("Client error at teardown", error))
  await db.connect()
  clients.push(db)
  return { db, url: ownerUrl.toString() }
}

async function apply(db: pg.Client, names: string[]) {
  for (const name of names) {
    const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8")
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.query(statement)
    }
  }
}

async function addRun(
  db: pg.Client,
  id: string,
  workflowName: string,
  status = "completed",
) {
  await db.query(
    `INSERT INTO openworkflow.workflow_runs
       (namespace_id, id, workflow_name, status, config, attempts, created_at, updated_at)
     VALUES ('default', $1, $2, $3, '{}', 1, now(), now())`,
    [id, workflowName, status],
  )
}

async function addStep(db: pg.Client, runId: string, stepName: string) {
  await db.query(
    `INSERT INTO openworkflow.step_attempts
       (namespace_id, id, workflow_run_id, step_name, kind, status, config, output, created_at, updated_at)
     VALUES ('default', $1, $2, $3, 'function', 'completed', '{}', $4, now(), now())`,
    [
      `${runId}/${stepName}`,
      runId,
      stepName,
      JSON.stringify({ objects: "UEFDSw==", step: stepName }),
    ],
  )
}

async function outputs(db: pg.Client) {
  const { rows } = await db.query<{ id: string; kept: boolean }>(
    `SELECT id, output IS NOT NULL AS kept FROM openworkflow.step_attempts ORDER BY id`,
  )
  return Object.fromEntries(rows.map((row) => [row.id, row.kept]))
}

describe("clear write step outputs migration (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    adminUrl = ownerUrlForMigrate(process.env.DATABASE_URL)
    admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
  }, 60_000)

  afterAll(async () => {
    for (const client of clients) await client.end()
    for (const database of databases) {
      await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    }
    await admin?.end()
  })

  it("the batched script clears the retired write step outputs and keeps the rows and other outputs; the migration drops the LangGraph tables", async () => {
    const { db, url } = await freshDatabase("write_outputs")
    await apply(
      db,
      migrations.filter((name) => name < target),
    )
    await migrateOpenWorkflow(url)
    for (const table of [
      "checkpoints",
      "checkpoint_blobs",
      "checkpoint_writes",
      "checkpoint_migrations",
    ]) {
      await db.query(`CREATE TABLE "public"."${table}" (id text)`)
    }

    await addRun(db, "merge", "workspace-write-semantic-merge")
    for (const step of [
      "acquire-revision",
      "transform-semantic-merge",
      "stage",
      "stage:2",
      "commit:1",
      "validate:12",
      "commit-subject",
      "broker-push",
    ]) {
      await addStep(db, "merge", step)
    }
    await addRun(db, "mirror", "workspace-write-connector-mirror")
    for (const step of [
      "transform-connector-mirror",
      "capture-config-binding",
      "usage",
    ]) {
      await addStep(db, "mirror", step)
    }
    await addRun(db, "boot", "workspace-write-bootstrap", "failed")
    await addStep(db, "boot", "commit-unborn")
    // The transform and handoff steps that stored file contents, and the new
    // prepare step that keeps its small output.
    await addRun(db, "edit", "workspace-write-ui-file-edit")
    for (const step of [
      "transform-file-edit",
      "capture-semantic-handoff:1",
      "prepare-commit",
    ]) {
      await addStep(db, "edit", step)
    }
    // The retired migration export workflow: each of its outputs goes.
    await addRun(db, "export", "workspace-write-migration-export")
    await addStep(db, "export", "export")
    // A run that can still resume keeps its outputs.
    await addRun(db, "live", "workspace-write-ui-file-edit", "sleeping")
    await addStep(db, "live", "stage")
    // A step of the same name in a workflow that is not a write workflow.
    await addRun(db, "ingest", "repository-ingestion-orchestrator")
    for (const step of ["stage", "discover-roots", "resolve"]) {
      await addStep(db, "ingest", step)
    }

    // The clear runs outside the deploy (batches that each commit), then the
    // migration drops the LangGraph tables.
    await db.query(
      readFileSync(join(__dirname, "clear-write-step-outputs.sql"), "utf8"),
    )
    await apply(db, [target])

    expect(await outputs(db)).toEqual({
      "boot/commit-unborn": false,
      "edit/capture-semantic-handoff:1": false,
      "edit/prepare-commit": true,
      "edit/transform-file-edit": false,
      "export/export": false,
      "ingest/discover-roots": true,
      "ingest/resolve": true,
      "ingest/stage": true,
      "live/stage": true,
      "merge/acquire-revision": false,
      "merge/broker-push": true,
      "merge/commit-subject": false,
      "merge/commit:1": false,
      "merge/stage": false,
      "merge/stage:2": false,
      "merge/transform-semantic-merge": false,
      "merge/validate:12": false,
      "mirror/capture-config-binding": true,
      "mirror/transform-connector-mirror": false,
      "mirror/usage": true,
    })
    const { rows } = await db.query<{ name: string | null }>(
      `SELECT to_regclass(t) AS name FROM unnest(ARRAY[
         'public.checkpoints', 'public.checkpoint_blobs',
         'public.checkpoint_writes', 'public.checkpoint_migrations']) AS t`,
    )
    expect(rows.map((row) => row.name)).toEqual([null, null, null, null])

    await apply(db, [target])
    await apply(
      db,
      migrations.filter((name) => name > target),
    )
  }, 120_000)

  it("passes on a database without the OpenWorkflow schema and the LangGraph tables", async () => {
    // A new database: Drizzle runs before the OpenWorkflow schema migration.
    const { db } = await freshDatabase("no_ow")
    await apply(
      db,
      migrations.filter((name) => name <= target),
    )
    const { rows } = await db.query<{ name: string | null }>(
      `SELECT to_regclass('openworkflow.step_attempts') AS name`,
    )
    expect(rows[0]?.name).toBeNull()
  }, 120_000)
})
