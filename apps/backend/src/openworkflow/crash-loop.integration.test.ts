import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { sql } from "drizzle-orm"
import { OpenWorkflow, type Workflow } from "openworkflow"
import type { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { z } from "zod"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { skillStepName } from "../domain/ingestion/ingestion-plan.js"
import {
  MAX_CRASHED_STEP_ATTEMPTS,
  StepCrashLoopError,
  withCrashLoopGuard,
} from "./crash-loop.js"
import { defineWorkflow } from "./defineObservedWorkflow.js"
import { connectOpenWorkflowBackend } from "./storable-backend.js"
import {
  guardedSkillStep,
  type IngestionShardWorkspace,
  runSkillPages,
} from "./workflows/ingestion-shard.js"

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
  hoursAgo = 0,
) {
  attempts++
  await getSystemDb().execute(sql`
    insert into openworkflow.step_attempts
      (namespace_id, id, workflow_run_id, step_name, kind, status, config,
       started_at, created_at, updated_at)
    values
      (${namespace}, ${`${run}-attempt-${attempts}`}, ${run}, ${step},
       ${kind}, ${status}, '{}'::jsonb,
       now() - make_interval(hours => ${hoursAgo}::int),
       now() - make_interval(hours => ${hoursAgo}::int), now())
  `)
}

let backend: BackendPostgres
let ow: OpenWorkflow

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", pr)
  // The backend reads the namespace of the stubbed PR environment.
  backend = await connectOpenWorkflowBackend(connectionString)
  ow = new OpenWorkflow({ backend })
})

/**
 * Run `workflow` on a real OpenWorkflow worker. Before the worker claims
 * the run, `crashed` adds the attempts that earlier worker stops left
 * `running`. OpenWorkflow then writes the attempt of this worker before
 * the step body runs, as in production.
 */
async function runAfterCrashes<Input, Output, Raw>(
  workflow: Workflow<Input, Output, Raw>,
  crashed: (runId: string) => Promise<void>,
) {
  ow.implementWorkflow(workflow.spec, workflow.fn)
  const handle = await ow.runWorkflow(workflow.spec, {} as Raw)
  await crashed(handle.workflowRun.id)
  const worker = ow.newWorker({ concurrency: 1 })
  await worker.start()
  try {
    const output = await handle.result({ timeoutMs: 30_000 })
    const steps = await backend.listStepAttempts({
      workflowRunId: handle.workflowRun.id,
    })
    return { output, steps: steps.data }
  } finally {
    await worker.stop()
  }
}

const once = { maximumAttempts: 1 }
let workflows = 0

/** A workflow with one guarded step that returns `ran`, or `crash-loop`. */
function guardedStepWorkflow(step: string) {
  workflows++
  return defineWorkflow(
    {
      name: `crash-loop-${pr}-${workflows}`,
      schema: z.object({}),
      retryPolicy: once,
    },
    async ({ step: steps, run }) =>
      steps.run({ name: step, retryPolicy: once }, () =>
        withCrashLoopGuard(
          run.id,
          step,
          async () => "ran",
          () => "crash-loop",
        ),
      ),
  )
}

afterAll(async () => {
  await getSystemDb().execute(
    sql`delete from openworkflow.step_attempts where namespace_id = ${namespace}`,
  )
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace}`,
  )
  await backend.stop()
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

it("runs a real step after two worker stops, and ends it with the fallback after three", async () => {
  const twice = await runAfterCrashes(
    guardedStepWorkflow("discover"),
    async (runId) => {
      for (let i = 0; i < MAX_CRASHED_STEP_ATTEMPTS - 1; i++)
        await startAttempt(runId, "discover")
    },
  )
  expect(twice.output).toBe("ran")

  const looped = await runAfterCrashes(
    guardedStepWorkflow("discover"),
    async (runId) => {
      for (let i = 0; i < MAX_CRASHED_STEP_ATTEMPTS; i++)
        await startAttempt(runId, "discover")
    },
  )
  expect(looped.output).toBe("crash-loop")
  // OpenWorkflow stored the step under the name that the guard counts, and
  // the fallback ended it: no retry.
  expect(
    looped.steps
      .filter((attempt) => attempt.status === "completed")
      .map((attempt) => [attempt.stepName, attempt.output]),
  ).toEqual([["discover", "crash-loop"]])
})

it("does not count worker stops older than 2 hours, such as old deploys", async () => {
  const { output } = await runAfterCrashes(
    guardedStepWorkflow("discover"),
    async (runId) => {
      for (let i = 0; i < MAX_CRASHED_STEP_ATTEMPTS; i++)
        await startAttempt(runId, "discover", "running", "function", 3)
    },
  )
  expect(output).toBe("ran")
})

it("ends a crash-looping skill step partial, so the run goes on", async () => {
  const workspaceId = "ws_crash_loop"
  const name = skillStepName(null, "libraries", workspaceId)
  workflows++
  const workflow = defineWorkflow(
    {
      name: `crash-loop-${pr}-${workflows}`,
      schema: z.object({}),
      retryPolicy: once,
    },
    async ({ step, run }) => {
      const state: IngestionShardWorkspace = {
        workspaceId,
        tip: null,
        ops: 0,
        rejects: 0,
        partial: 0,
        partialRoots: [],
      }
      // The step body does not run, so the run, broker, and runtime are
      // not used.
      await runSkillPages({
        step: guardedSkillStep(step, run.id, "org_crash_loop"),
        run: {} as never,
        broker: {} as never,
        runtime: {} as never,
        root: null,
        skill: { name: "libraries" } as never,
        destination: { workspaceId } as never,
        ref: "refs/ctxpipe/ingest/test",
        runBase: "0".repeat(40),
        state,
      })
      return state
    },
  )
  const { output, steps } = await runAfterCrashes(workflow, async (runId) => {
    for (let i = 0; i < MAX_CRASHED_STEP_ATTEMPTS; i++)
      await startAttempt(runId, name)
  })
  expect(output).toMatchObject({
    partial: 1,
    stepFailures: { crashLoop: 1 },
  })
  expect(
    steps
      .filter((attempt) => attempt.status === "completed")
      .map((attempt) => [attempt.stepName, attempt.output]),
  ).toEqual([[name, { partial: true, failed: "crashLoop" }]])
})
