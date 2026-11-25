import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"
import type { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { INGESTION_SHARD_WORKFLOW_NAME } from "../domain/ingestion/ingestion-run.js"
import { startQueueDepthReports } from "./queue-depth.js"
import { connectOpenWorkflowBackend } from "./storable-backend.js"

// The test setup gives this file its own OpenWorkflow namespace, so the
// claims and the queue depth see only the runs of this file.
const lease = { leaseDurationMs: 30_000 }
const backends: BackendPostgres[] = []

/** One worker process: a backend and the ids of its 4 slots. */
async function workerProcess() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required")
  // A worker process of 4 slots has a share of 2 shards.
  vi.stubEnv("OPENWORKFLOW_CONCURRENCY", "4")
  const backend = await connectOpenWorkflowBackend(url)
  vi.unstubAllEnvs()
  backends.push(backend)
  const slots = Array.from({ length: 4 }, () => randomUUID())
  return {
    backend,
    slots,
    /** One poll: each slot claims at the same time, as the worker does. */
    poll: (from = slots) =>
      Promise.all(
        from.map(async (workerId) => {
          const run = await backend.claimWorkflowRun({ workerId, ...lease })
          return run && { id: run.id, workerId }
        }),
      ),
  }
}

/** A run that waits for a worker since `secondsAgo`. */
async function queue(
  backend: BackendPostgres,
  workflowName: string,
  secondsAgo: number,
) {
  const run = await backend.createWorkflowRun({
    workflowName,
    version: null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: null,
    parentStepAttemptNamespaceId: null,
    parentStepAttemptId: null,
    availableAt: new Date(Date.now() - secondsAgo * 1000),
    deadlineAt: null,
  })
  return run.id
}

async function workerQueueDepth() {
  const lines: string[] = []
  const reports = startQueueDepthReports((line) => lines.push(line))
  await reports.firstSample
  reports.stop()
  return JSON.parse(lines[0] ?? "{}").WorkerQueueDepth
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
})

afterAll(async () => {
  await Promise.all(backends.map((backend) => backend.stop()))
  await closeDb()
})

it("keeps the shards over the share in the queue, counted, and gives each free place to the shard that waits longest", async () => {
  const first = await workerProcess()
  const shards = [
    await queue(first.backend, INGESTION_SHARD_WORKFLOW_NAME, 50),
    await queue(first.backend, INGESTION_SHARD_WORKFLOW_NAME, 40),
    await queue(first.backend, INGESTION_SHARD_WORKFLOW_NAME, 30),
    await queue(first.backend, INGESTION_SHARD_WORKFLOW_NAME, 20),
  ]
  const sync = await queue(first.backend, "connector-content-sync", 10)

  // The 4 slots poll at the same time: 2 take the oldest shards, 1 takes
  // the other workflow, and no slot takes a third shard.
  const claimed = (await first.poll()).filter((run) => run !== null)
  expect(claimed.map((run) => run.id).sort()).toEqual(
    [shards[0], shards[1], sync].sort(),
  )
  // The 2 shards that have no place wait in the queue, so the worker
  // autoscaling sees them.
  expect(await workerQueueDepth()).toBe(2)

  // A second worker process (a scale-out) takes the 2 waiting shards.
  const second = await workerProcess()
  const scaledOut = await second.poll()
  expect(
    scaledOut
      .map((run) => run?.id)
      .filter(Boolean)
      .sort(),
  ).toEqual([shards[2], shards[3]].sort())
  expect(await workerQueueDepth()).toBe(0)

  // Two more shards wait. When a shard of the first process ends, its free
  // place goes to the shard that waits longer, not to the newer one.
  const older = await queue(first.backend, INGESTION_SHARD_WORKFLOW_NAME, 5)
  await queue(first.backend, INGESTION_SHARD_WORKFLOW_NAME, 0)
  const ended = claimed.find((run) => run.id === shards[0])
  if (!ended) throw new Error("The first shard was not claimed")
  await first.backend.completeWorkflowRun({
    workflowRunId: ended.id,
    workerId: ended.workerId,
    output: null,
  })
  const busy = claimed.filter((run) => run !== ended).map((run) => run.workerId)
  const free = first.slots.filter((slot) => !busy.includes(slot))
  expect(free).toHaveLength(2)
  const next = await first.poll(free)
  expect(next.map((run) => run?.id ?? null).sort()).toEqual(
    [older, null].sort(),
  )
  // The newer shard waits, also while the process has a free slot.
  expect(await workerQueueDepth()).toBe(1)
})

it("does not count a shard whose lease ended as a shard that the process runs", async () => {
  const worker = await workerProcess()
  await queue(worker.backend, INGESTION_SHARD_WORKFLOW_NAME, 30)
  await queue(worker.backend, INGESTION_SHARD_WORKFLOW_NAME, 20)
  await queue(worker.backend, INGESTION_SHARD_WORKFLOW_NAME, 10)
  const [a, b, c] = worker.slots
  if (!a || !b || !c) throw new Error("The process has 4 slots")
  const held = (await worker.poll([a, b])).filter((run) => run !== null)
  expect(held).toHaveLength(2)
  expect(await worker.poll([c])).toEqual([null])

  // For example, the worker could not write the outcome of the run. No slot
  // runs it now, so it does not hold a place.
  await getSystemDb().execute(sql`
    update openworkflow.workflow_runs
    set available_at = now() - interval '1 second'
    where id = ${held[0]?.id}
  `)
  const [next] = await worker.poll([c])
  expect(next).not.toBeNull()
})
