import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { wakeParkedParents } from "./wake-parked-parents.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })

// A PR number of its own gives this file its own OpenWorkflow namespace.
const pr = `pr-${Date.now()}${Math.floor(Math.random() * 1000)}`
const namespace = `preview-${pr}`

async function insertRun(id: string, status: string, availableAt: string) {
  await getSystemDb().execute(sql`
    insert into openworkflow.workflow_runs
      (namespace_id, id, workflow_name, status, config, attempts, worker_id,
       available_at, started_at, created_at, updated_at)
    values
      (${namespace}, ${id}, 'repository-ingestion-v2', ${status}, '{}'::jsonb,
       1, null, ${availableAt}::timestamptz, now(), now(), now())
  `)
}

/** A parent parked on `runWorkflow` of a child, as OpenWorkflow parks it. */
async function insertParkedParent(parent: string, child: string) {
  await insertRun(parent, "running", "2099-01-01T00:00:00Z")
  await getSystemDb().execute(sql`
    insert into openworkflow.step_attempts
      (namespace_id, id, workflow_run_id, step_name, kind, status, config,
       child_workflow_run_namespace_id, child_workflow_run_id, started_at,
       created_at, updated_at)
    values
      (${namespace}, ${`${parent}-wait`}, ${parent}, 'repository-skills',
       'workflow', 'running', '{}'::jsonb, ${namespace}, ${child}, now(),
       now(), now())
  `)
}

async function availableAt(id: string): Promise<Date> {
  const result = await getSystemDb().execute<{ available_at: string }>(sql`
    select available_at from openworkflow.workflow_runs
    where namespace_id = ${namespace} and id = ${id}
  `)
  return new Date(result.rows[0]?.available_at ?? 0)
}

beforeAll(() => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", pr)
})

afterAll(async () => {
  await getSystemDb().execute(
    sql`delete from openworkflow.step_attempts where namespace_id = ${namespace}`,
  )
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace}`,
  )
  vi.unstubAllEnvs()
  await closeDb()
})

it("wakes a parent whose child ended without the wake, and only that parent", async () => {
  // The worker completed the child, then stopped before it woke the parent.
  await insertRun("child-done", "completed", "2026-01-01T00:00:00Z")
  await insertParkedParent("parent-lost-wake", "child-done")
  // This child still runs, so its parent waits on.
  await insertRun("child-running", "running", "2099-01-01T00:00:00Z")
  await insertParkedParent("parent-waiting", "child-running")

  const woken = await wakeParkedParents()

  expect(woken).toEqual(["parent-lost-wake"])
  expect((await availableAt("parent-lost-wake")).getTime()).toBeLessThan(
    Date.now() + 60_000,
  )
  expect((await availableAt("parent-waiting")).getUTCFullYear()).toBe(2099)
})
