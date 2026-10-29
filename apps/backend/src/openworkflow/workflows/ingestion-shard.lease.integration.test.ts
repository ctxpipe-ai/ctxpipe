import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { initLogger } from "evlog"
import { OpenWorkflow } from "openworkflow"
import type { BackendPostgres } from "openworkflow/postgres"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest"
import { z } from "zod"

import { recordSpans } from "../../../test/spans.js"
import { closeDb, getSystemDb, initDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  heldScratch,
  holdScratch,
} from "../../domain/ingestion/held-scratch.js"
import {
  findStepCommit,
  ingestRefName,
  listStepFiles,
  pushIngestStep,
} from "../../domain/ingestion/ingest-refs.js"
import type { IngestShardRuntime } from "../../domain/ingestion/ingest-shard-runtime.js"
import { releaseIngestStepIndexes } from "../../domain/ingestion/ingest-shard-sandbox.js"
import { releaseIngestSourceTree } from "../../domain/ingestion/ingest-source-tree.js"
import { WORKER_BOOT_ID } from "../crash-loop.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { openWorkflowExecution } from "../execution-lease.js"
import { cleanUpUnlessParked } from "../isSleepSignal.js"
import { connectOpenWorkflowBackend } from "../storable-backend.js"
import {
  guardedSkillStep,
  type IngestionShardWorkspace,
  runSkillPages,
  type SkillStepBroker,
} from "./ingestion-shard.js"

/*
 * A shard child whose OpenWorkflow lease another execution took (CTX-1080).
 * The worker is a real OpenWorkflow worker on Postgres. The test takes the
 * run as a second worker claim does: it sets another `worker_id` and adds
 * one to `attempts`. The step broker is a local git remote; only the model
 * call of the sandbox is a stand-in.
 */

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local"), quiet: true })

// A PR number of its own gives this file its own OpenWorkflow namespace.
const pr = `pr-${Date.now()}${Math.floor(Math.random() * 1000)}`
const namespace = `preview-${pr}`
const orgId = `org_lease_${pr}`
const workspaceId = "ws_lease"
const ingestionRunId = "run_lease"
const ref = ingestRefName({ runId: ingestionRunId, workspaceId, shard: "0" })
const once = { maximumAttempts: 1 }
const spans = recordSpans()
const events: Array<Record<string, unknown>> = []

let backend: BackendPostgres
let ow: OpenWorkflow
let workflows = 0
let folder: string
let pinned: string
let remote: { url: string }

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim()
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  initDb(connectionString)
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", pr)
  backend = await connectOpenWorkflowBackend(connectionString)
  ow = new OpenWorkflow({ backend })
  await getSystemDb()
    .insert(organizations)
    .values({ id: orgId, name: "Lease", slug: orgId, createdAt: new Date() })
})

beforeEach(() => {
  events.length = 0
  folder = mkdtempSync(join(tmpdir(), "ingest-lease-"))
  const work = join(folder, "work")
  mkdirSync(work)
  git(work, "init", "-q", "-b", "main")
  writeFileSync(join(work, "README.md"), "# Context\n")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "seed")
  pinned = git(work, "rev-parse", "HEAD")
  remote = { url: join(folder, "remote.git") }
  git(folder, "clone", "-q", "--bare", work, remote.url)
  initLogger({
    pretty: false,
    silent: true,
    env: { service: "ctxpipe-backend-test" },
    drain: (ctx) => {
      events.push(ctx.event as Record<string, unknown>)
    },
  })
})

afterEach(() => {
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  rmSync(folder, { recursive: true, force: true })
})

afterAll(async () => {
  await getSystemDb().execute(
    sql`delete from openworkflow.step_attempts where namespace_id = ${namespace}`,
  )
  await getSystemDb().execute(
    sql`delete from openworkflow.workflow_runs where namespace_id = ${namespace}`,
  )
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await backend.stop()
  vi.unstubAllEnvs()
  await closeDb()
})

type RunRow = { worker_id: string | null; attempts: number }

async function runRow(runId: string): Promise<RunRow | undefined> {
  const rows = await getSystemDb().execute<RunRow>(sql`
    select worker_id, attempts from openworkflow.workflow_runs
    where namespace_id = ${namespace} and id = ${runId}
  `)
  return rows.rows[0]
}

/** A second claim of the run, as when the lease ran out (CTX-1009). */
async function anotherExecutionTakes(runId: string) {
  await getSystemDb().execute(sql`
    update openworkflow.workflow_runs
    set worker_id = 'worker-of-the-other-execution',
      attempts = attempts + 1,
      available_at = now() + interval '10 minutes'
    where namespace_id = ${namespace} and id = ${runId}
  `)
}

async function stepStatuses(runId: string) {
  const rows = await getSystemDb().execute<{ status: string }>(sql`
    select status from openworkflow.step_attempts
    where namespace_id = ${namespace} and workflow_run_id = ${runId}
    order by created_at
  `)
  return rows.rows.map((row) => row.status)
}

/**
 * Run one skill step on a real worker. The first attempt fails after
 * another execution took the run (the worker stalled; for example, the
 * sandbox lock went to the other execution). `cleanUp` runs as the cleanup
 * of an ingestion workflow does.
 */
async function runStaleExecution(
  options: { cleanUp?: () => Promise<void> } = {},
) {
  const calls: number[] = []
  let runId = ""
  const runtime: IngestShardRuntime = {
    ensure: async () => {},
    discoverRoots: async () => ({}),
    runStep: async () => {
      calls.push(calls.length + 1)
      if (calls.length === 1) await anotherExecutionTakes(runId)
      throw new Error("Sandbox lock ownership expired")
    },
  }
  const result = await runOnWorker(
    runtime,
    (id) => {
      runId = id
    },
    options.cleanUp,
  )
  return { calls, runId: result.runId }
}

/** Run one skill step with `runtime` on a real OpenWorkflow worker. */
async function runOnWorker(
  runtime: IngestShardRuntime,
  started: (workflowRunId: string) => void,
  cleanUp?: () => Promise<void>,
) {
  // The other execution has not pushed: the ref has no commit.
  const broker: SkillStepBroker = {
    find: (ref, step, since) =>
      findStepCommit({ remote, ref, step, runId: ingestionRunId, since }),
    listFiles: (pinnedRevision, tip) =>
      listStepFiles({ remote, runId: ingestionRunId, pinnedRevision, tip }),
    push: (input) =>
      pushIngestStep({
        ...input,
        remote,
        job: { runId: ingestionRunId, workspaceId },
      }),
    sourcePathExists: async () => false,
    readSourceFile: async () => null,
  }
  let ended = false
  workflows++
  const workflow = defineWorkflow(
    {
      name: `ingest-lease-${pr}-${workflows}`,
      schema: z.object({}),
      retryPolicy: once,
    },
    async ({ step, run }) => {
      started(run.id)
      const state: IngestionShardWorkspace = {
        workspaceId,
        tip: null,
        ops: 0,
        rejects: 0,
        partial: 0,
        partialRoots: [],
      }
      const body = async () => {
        await runSkillPages({
          step: guardedSkillStep(step, run.id, orgId),
          execution: openWorkflowExecution(step, run.id),
          run: {
            runId: ingestionRunId,
            shard: 0,
            bundle: "bundle-1",
            source: {
              kind: "github",
              url: "https://github.com/example-org/shop",
              githubConnectionId: "con_source",
              sha: "a".repeat(40),
              repositoryId: null,
            },
            authorTime: "2026-10-01T00:00:00Z",
            roots: [],
          },
          broker,
          runtime,
          root: null,
          skill: { name: "apis", scope: "repository", run: "model" },
          destination: {
            workspaceId,
            url: "https://github.com/example-org/context",
            githubConnectionId: "con_test",
            generation: 1,
            pinnedRevision: pinned,
            repositoryId: null,
            sourcePath: "sources/github/example-org/shop.md",
          },
          ref,
          runBase: pinned,
          state,
        })
        return state
      }
      try {
        return await (cleanUp ? cleanUpUnlessParked(body, cleanUp) : body())
      } finally {
        ended = true
      }
    },
  )
  ow.implementWorkflow(workflow.spec, workflow.fn)
  const handle = await ow.runWorkflow(workflow.spec, {})
  const worker = ow.newWorker({ concurrency: 1 })
  await worker.start()
  await vi.waitFor(() => expect(ended).toBe(true), { timeout: 45_000 })
  // `stop` waits until the execution of this worker ends.
  await worker.stop()
  return { runId: handle.workflowRun.id }
}

it(
  "makes no model call after another execution took the run",
  { timeout: 60_000 },
  async () => {
    const { calls, runId } = await runStaleExecution()
    expect(calls).toEqual([1])
    // The other execution owns the run. OpenWorkflow refused the outcome of
    // the stale execution's step, so the attempt stays `running`.
    expect(await runRow(runId)).toEqual({
      worker_id: "worker-of-the-other-execution",
      attempts: 2,
    })
    expect(await stepStatuses(runId)).toEqual(["running"])
  },
)

it(
  "reads the worker id of the execution on the installed OpenWorkflow",
  { timeout: 30_000 },
  async () => {
    let workerId: string | undefined
    let row: RunRow | undefined
    workflows++
    const workflow = defineWorkflow(
      {
        name: `ingest-lease-${pr}-${workflows}`,
        schema: z.object({}),
        retryPolicy: once,
      },
      async ({ step, run }) => {
        workerId = openWorkflowExecution(step, run.id)?.workerId
        row = await runRow(run.id)
        return null
      },
    )
    ow.implementWorkflow(workflow.spec, workflow.fn)
    await ow.runWorkflow(workflow.spec, {})
    const worker = ow.newWorker({ concurrency: 1 })
    await worker.start()
    await vi.waitFor(() => expect(row).toBeDefined(), { timeout: 15_000 })
    await worker.stop()
    expect(
      workerId,
      "OpenWorkflow no longer gives the worker id on its step executor (StepExecutor.workerId), so no step checks the lease of its run",
    ).toBe(row?.worker_id)
  },
)

it("logs a step executor that has no worker id", () => {
  expect(openWorkflowExecution({}, "wr_1")).toBeUndefined()
  expect(
    events.filter((e) => e.step === "openworkflow.worker_id_missing"),
  ).toEqual([expect.objectContaining({ level: "warn", workflowRunId: "wr_1" })])
})

/** The tar of a step output with one Service file. */
function serviceArchive() {
  const out = mkdtempSync(join(folder, "out-"))
  mkdirSync(join(out, "files/knowledge/services"), { recursive: true })
  writeFileSync(
    join(out, "files/knowledge/services/orders.md"),
    "---\nkind: Service\nname: Orders\n---\n# Orders\n\nThe orders service.\n",
  )
  writeFileSync(
    join(out, "patch.json"),
    JSON.stringify({
      ops: [{ op: "create", path: "knowledge/services/orders.md" }],
    }),
  )
  return execFileSync("tar", ["-cf", "-", "-C", out, "patch.json", "files"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
}

it(
  "makes each model call that a live execution needs",
  { timeout: 60_000 },
  async () => {
    const calls: number[] = []
    const runtime: IngestShardRuntime = {
      ensure: async () => {},
      discoverRoots: async () => ({}),
      runStep: async () => {
        calls.push(calls.length + 1)
        if (calls.length < 3) throw new Error("Sandbox lock ownership expired")
        return { tar: serviceArchive() }
      },
    }
    const { runId } = await runOnWorker(runtime, () => {})
    expect(calls).toEqual([1, 2, 3])
    expect(
      events.filter((e) => e.step === "ingestion-v2.execution-lease-lost"),
    ).toEqual([])
    expect(
      events
        .filter((e) => e.step === "ingestion-v2.step-attempt-started")
        .map((e) => [e.attempt, e.executionAttempt]),
    ).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ])
    expect(await stepStatuses(runId)).toEqual(["completed"])
  },
)

it(
  "leaves the scratch of the live execution when the stale execution stops",
  { timeout: 60_000 },
  async () => {
    // The live execution of the same child, in this process, holds the
    // index repositories and the source tree of the shard.
    const live = mkdtempSync(join(folder, "live-"))
    const keys = [
      `index:${ingestionRunId}:0:${workspaceId}`,
      `tree:${ingestionRunId}:${"a".repeat(40)}:roots:0`,
    ]
    for (const key of keys) await holdScratch(key, async () => ({ dir: live }))
    await runStaleExecution({
      // The cleanup of the shard child.
      cleanUp: async () => {
        await releaseIngestSourceTree(ingestionRunId, "a".repeat(40), "roots:0")
        await releaseIngestStepIndexes(ingestionRunId, 0)
      },
    })
    expect(existsSync(live)).toBe(true)
    expect(heldScratch(`index:${ingestionRunId}:0:`)).toBe(1)
    expect(heldScratch(`tree:${ingestionRunId}:`)).toBe(1)
    await releaseIngestSourceTree(ingestionRunId, "a".repeat(40), "roots:0")
    await releaseIngestStepIndexes(ingestionRunId, 0)
  },
)

it(
  "names the execution on the step events and the step span",
  { timeout: 60_000 },
  async () => {
    await runStaleExecution()
    const identity = { workerBootId: WORKER_BOOT_ID, executionAttempt: 1 }
    const started = events.filter(
      (e) => e.step === "ingestion-v2.step-attempt-started",
    )
    expect(started).toEqual([
      expect.objectContaining({ attempt: 1, ...identity }),
    ])
    expect(
      events.filter((e) => e.step === "ingestion-v2.step-attempt-failed"),
    ).toEqual([expect.objectContaining({ attempt: 1, ...identity })])
    // One key for each concept: the OpenWorkflow worker id is only on the
    // lease extension event of the backend.
    expect(started[0]).not.toHaveProperty("workflowWorkerId")
    const attributes = spans.spanNamed("ingestion.step")?.attributes ?? {}
    expect(attributes["openworkflow.execution.attempt"]).toBe(1)
    expect(attributes).not.toHaveProperty("ctxpipe.worker.boot_id")
    expect(attributes).not.toHaveProperty("ctxpipe.openworkflow.worker.id")
  },
)

it(
  "logs the lease loss with the run and the stale execution",
  { timeout: 60_000 },
  async () => {
    const { runId } = await runStaleExecution()
    expect(
      events.filter((e) => e.step === "ingestion-v2.execution-lease-lost"),
    ).toEqual([
      expect.objectContaining({
        level: "warn",
        ingestionRunId,
        shard: 0,
        workspaceId,
        ingestStep: "skill:repository:apis:ws_lease",
        attempt: 2,
        workflowRunId: runId,
        workerBootId: WORKER_BOOT_ID,
        executionAttempt: 1,
      }),
    ])
    expect(
      events.find((e) => e.step === "ingestion-v2.execution-lease-lost"),
    ).not.toHaveProperty("workflowWorkerId")
  },
)
