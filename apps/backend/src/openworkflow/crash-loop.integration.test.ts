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
  failInFlightStepAttempts,
  MAX_CRASHED_STEP_ATTEMPTS,
  StepCrashLoopError,
  stopGuardedStepAttempts,
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

it("marks the attempt of a stopped worker failed, so three deploys in a step do not trip the guard", async () => {
  const stops = MAX_CRASHED_STEP_ATTEMPTS
  // An attempt of another worker process: the stop must not change it.
  await insertRun("run-foreign")
  await startAttempt("run-foreign", "deploy")
  const statusesAtStop: string[][] = []
  let bodies = 0
  workflows++
  const workflow = defineWorkflow(
    {
      name: `crash-loop-${pr}-${workflows}`,
      schema: z.object({}),
      retryPolicy: once,
    },
    async ({ step, run }) =>
      step.run(
        {
          name: "deploy",
          retryPolicy: {
            initialInterval: "10ms",
            backoffCoefficient: 1,
            maximumInterval: "10ms",
            maximumAttempts: stops + 1,
          },
        },
        () =>
          withCrashLoopGuard(
            run.id,
            "deploy",
            async () => {
              bodies++
              if (bodies > stops) return "ran"
              // SIGTERM comes while the step body runs.
              expect(await failInFlightStepAttempts()).toBe(1)
              const rows = await getSystemDb().execute<{ status: string }>(sql`
                select status from openworkflow.step_attempts
                where namespace_id = ${namespace}
                  and step_name = 'deploy'
                order by created_at
              `)
              statusesAtStop.push(rows.rows.map((row) => row.status))
              // The process stops here. In the test, the body throws, so
              // OpenWorkflow runs the step again as the next worker would.
              throw new Error("worker stopped")
            },
            () => "crash-loop",
          ),
      ),
  )
  const { output, steps } = await runAfterCrashes(workflow, async () => {})
  expect(output).toBe("ran")
  // At each stop, only the attempt of this process became `failed`.
  expect(statusesAtStop).toEqual([
    ["running", "failed"],
    ["running", "failed", "failed"],
    ["running", "failed", "failed", "failed"],
  ])
  expect(steps.map((attempt) => attempt.status).sort()).toEqual([
    "completed",
    "failed",
    "failed",
    "failed",
  ])
  // Nothing is in flight after the step: a later stop marks nothing.
  expect(await failInFlightStepAttempts()).toBe(0)
})

/** The stop flag of `crash-loop.ts`. The tests set it back after a stop. */
function workerStopState() {
  const state = (
    globalThis as unknown as Record<symbol, { stopping: boolean } | undefined>
  )[Symbol.for("ctxpipe.openworkflow.worker-stop-state")]
  if (!state) throw new Error("crash-loop.ts keeps no stop state")
  return state
}

async function runState(runId: string, step: string) {
  const attempts = await getSystemDb().execute<{ status: string }>(sql`
    select status from openworkflow.step_attempts
    where namespace_id = ${namespace}
      and workflow_run_id = ${runId}
      and step_name = ${step}
    order by created_at
  `)
  const runs = await getSystemDb().execute<{ status: string }>(sql`
    select status from openworkflow.workflow_runs
    where namespace_id = ${namespace} and id = ${runId}
  `)
  return {
    attempts: attempts.rows.map((row) => row.status),
    run: runs.rows[0]?.status,
  }
}

/**
 * Start a worker that gets SIGTERM. Its guarded steps do not end, so the
 * test does not wait for it to stop; the process would exit.
 */
async function startStoppedWorker(check: () => Promise<void>) {
  const worker = ow.newWorker({ concurrency: 1 })
  await worker.start()
  try {
    await vi.waitFor(check, { timeout: 15_000, interval: 100 })
    // Nothing writes a result or an error later.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await check()
  } finally {
    workerStopState().stopping = false
    void worker.stop()
  }
}

it("does not end a step whose body ends after the stop marked it, so the next worker runs it again", async () => {
  let bodies = 0
  workflows++
  const workflow = defineWorkflow(
    {
      name: `crash-loop-${pr}-${workflows}`,
      schema: z.object({}),
      retryPolicy: once,
    },
    async ({ step, run }) =>
      step.run({ name: "drain", retryPolicy: once }, () =>
        withCrashLoopGuard(run.id, "drain", async () => {
          bodies++
          // SIGTERM comes while the first body runs. The body then ends
          // while the worker flushes its logs, before the process exits.
          if (bodies === 1) expect(await stopGuardedStepAttempts()).toBe(1)
          return "ran"
        }),
      ),
  )
  ow.implementWorkflow(workflow.spec, workflow.fn)
  const handle = await ow.runWorkflow(workflow.spec, {})
  const runId = handle.workflowRun.id

  await startStoppedWorker(async () => {
    expect(await runState(runId, "drain")).toEqual({
      attempts: ["failed"],
      run: "running",
    })
  })
  expect(bodies).toBe(1)

  // The next worker claims the run when the lease of the stopped one ends.
  await getSystemDb().execute(sql`
    update openworkflow.workflow_runs set available_at = now()
    where namespace_id = ${namespace} and id = ${runId}
  `)
  const next = ow.newWorker({ concurrency: 1 })
  await next.start()
  try {
    expect(await handle.result({ timeoutMs: 30_000 })).toBe("ran")
  } finally {
    await next.stop()
  }
  expect(bodies).toBe(2)
  expect(await runState(runId, "drain")).toEqual({
    attempts: ["failed", "completed"],
    run: "completed",
  })
})

it("does not run a guarded step that starts after SIGTERM, and marks its attempt failed", async () => {
  let bodies = 0
  workflows++
  const workflow = defineWorkflow(
    {
      name: `crash-loop-${pr}-${workflows}`,
      schema: z.object({}),
      retryPolicy: once,
    },
    async ({ step, run }) =>
      step.run({ name: "late", retryPolicy: once }, () =>
        withCrashLoopGuard(run.id, "late", async () => {
          bodies++
          return "ran"
        }),
      ),
  )
  ow.implementWorkflow(workflow.spec, workflow.fn)
  const handle = await ow.runWorkflow(workflow.spec, {})
  // SIGTERM came, with no guarded step in flight.
  expect(await stopGuardedStepAttempts()).toBe(0)

  await startStoppedWorker(async () => {
    expect(await runState(handle.workflowRun.id, "late")).toEqual({
      attempts: ["failed"],
      run: "running",
    })
  })
  expect(bodies).toBe(0)
})
