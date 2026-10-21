import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import {
  MAX_CRASHED_STEP_ATTEMPTS,
  StepCrashLoopError,
  withCrashLoopGuard,
} from "./crash-loop.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })

// A PR number of its own gives this file its own OpenWorkflow namespace.
const pr = `pr-${Date.now()}${Math.floor(Math.random() * 1000)}`
const namespace = `preview-${pr}`
let attempts = 0

async function insertRun(id: string) {
  await getSystemDb().execute(sql`
    insert into openworkflow.workflow_runs
      (namespace_id, id, workflow_name, status, config, attempts, worker_id,
       available_at, started_at, created_at, updated_at)
    values
      (${namespace}, ${id}, 'ingestion-shard', 'running', '{}'::jsonb, 1,
       null, now(), now(), now(), now())
  `)
}

/**
 * A step attempt as OpenWorkflow writes it before the step body runs. A
 * worker that stops in the body (out of memory) leaves it `running`: this is
 * the fake crash.
 */
async function startAttempt(
  run: string,
  step: string,
  status: "running" | "completed" | "failed" = "running",
  kind = "function",
) {
  attempts++
  await getSystemDb().execute(sql`
    insert into openworkflow.step_attempts
      (namespace_id, id, workflow_run_id, step_name, kind, status, config,
       started_at, created_at, updated_at)
    values
      (${namespace}, ${`${run}-attempt-${attempts}`}, ${run}, ${step},
       ${kind}, ${status}, '{}'::jsonb, now(), now(), now())
  `)
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

it("runs the step until earlier attempts stopped the worker three times, then fails it with the cause", async () => {
  await insertRun("run-crash")
  const step = "skill:apps/api:apis.3:ws_test"
  let ran = 0
  const body = async () => {
    ran++
    return "done"
  }

  // Each worker start makes a new attempt, then runs the body in it.
  for (let crash = 0; crash < MAX_CRASHED_STEP_ATTEMPTS; crash++) {
    await startAttempt("run-crash", step)
    expect(await withCrashLoopGuard("run-crash", step, body)).toBe("done")
    // The worker stopped in the body: the attempt stays `running`.
  }
  expect(ran).toBe(MAX_CRASHED_STEP_ATTEMPTS)

  await startAttempt("run-crash", step)
  const failed = withCrashLoopGuard("run-crash", step, body)
  await expect(failed).rejects.toBeInstanceOf(StepCrashLoopError)
  await expect(failed).rejects.toThrow(
    `The worker stopped 3 times during the step "${step}"`,
  )
  expect(ran).toBe(MAX_CRASHED_STEP_ATTEMPTS)
})

it("does not count finished attempts, other steps, other runs, or child workflow waits", async () => {
  await insertRun("run-healthy")
  await insertRun("run-other")
  const step = "skill:repository:libraries:ws_test"
  await startAttempt("run-healthy", step, "failed")
  await startAttempt("run-healthy", step, "failed")
  await startAttempt("run-healthy", step, "completed")
  await startAttempt("run-healthy", "ensure-sandbox")
  await startAttempt("run-healthy", step, "running", "workflow")
  for (let i = 0; i < MAX_CRASHED_STEP_ATTEMPTS; i++)
    await startAttempt("run-other", step)
  // The attempt of the caller.
  await startAttempt("run-healthy", step)

  expect(
    await withCrashLoopGuard("run-healthy", step, async () => "done"),
  ).toBe("done")
})
