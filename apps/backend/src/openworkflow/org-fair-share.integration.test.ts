import { randomUUID } from "node:crypto"

import type { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { closeDb, initDb } from "../db/client.js"
import { INGESTION_SHARD_WORKFLOW_NAME } from "../domain/ingestion/ingestion-run.js"
import { connectOpenWorkflowBackend } from "./storable-backend.js"

// The test setup gives this file its own OpenWorkflow namespace, so the
// claims see only the runs of this file.
const lease = { leaseDurationMs: 30_000 }
const backends: BackendPostgres[] = []

/** One worker process: a backend and the ids of its 4 slots. */
async function workerProcess() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required")
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

/** A run of `orgId` that waits for a worker since `secondsAgo`. */
async function queue(
  backend: BackendPostgres,
  input: { workflowName: string; orgId: string | null; secondsAgo: number },
) {
  const run = await backend.createWorkflowRun({
    workflowName: input.workflowName,
    version: null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: input.orgId === null ? {} : { orgId: input.orgId },
    parentStepAttemptNamespaceId: null,
    parentStepAttemptId: null,
    availableAt: new Date(Date.now() - input.secondsAgo * 1000),
    deadlineAt: null,
  })
  return run.id
}

/** Made-up org ids, new for each run of the test. */
function orgs() {
  const suffix = randomUUID().slice(0, 8)
  return { busy: `org_busy_${suffix}`, other: `org_other_${suffix}` }
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
})

afterAll(async () => {
  await Promise.all(backends.map((backend) => backend.stop()))
  await closeDb()
})

it("gives slots to the runs of a second org while a first org has a large backlog", async () => {
  const worker = await workerProcess()
  const org = orgs()
  // The first org queued 20 runs before the second org queued its 2 runs.
  for (let i = 0; i < 20; i++)
    await queue(worker.backend, {
      workflowName: "workspace-write-semantic-merge",
      orgId: org.busy,
      secondsAgo: 100 - i,
    })
  const other = [
    await queue(worker.backend, {
      workflowName: "workspace-sources-sync",
      orgId: org.other,
      secondsAgo: 10,
    }),
    await queue(worker.backend, {
      workflowName: "github-sync-pull-request",
      orgId: org.other,
      secondsAgo: 5,
    }),
  ]

  const claimed = (await worker.poll()).filter((run) => run !== null)
  expect(claimed).toHaveLength(4)
  expect(claimed.map((run) => run.id)).toEqual(expect.arrayContaining(other))
})

it("lets one org use each free slot when no other org waits", async () => {
  const worker = await workerProcess()
  const org = orgs()
  for (let i = 0; i < 6; i++)
    await queue(worker.backend, {
      workflowName: "workspace-write-semantic-merge",
      orgId: org.busy,
      secondsAgo: 60 - i,
    })

  const claimed = (await worker.poll()).filter((run) => run !== null)
  expect(claimed).toHaveLength(4)
})

it("gives a free ingestion place to the shard of an org that runs no shard", async () => {
  const worker = await workerProcess()
  const org = orgs()
  const [a, b, c] = worker.slots
  if (!a || !b || !c) throw new Error("The process has 4 slots")
  // The first org queued its shards first, and the share of the process (2
  // shards) runs 2 of them.
  const busyShards = [] as string[]
  for (let i = 0; i < 6; i++)
    busyShards.push(
      await queue(worker.backend, {
        workflowName: INGESTION_SHARD_WORKFLOW_NAME,
        orgId: org.busy,
        secondsAgo: 100 - i,
      }),
    )
  const held = (await worker.poll([a, b])).filter((run) => run !== null)
  expect(held.map((run) => run.id).sort()).toEqual(
    busyShards.slice(0, 2).sort(),
  )

  const otherShard = await queue(worker.backend, {
    workflowName: INGESTION_SHARD_WORKFLOW_NAME,
    orgId: org.other,
    secondsAgo: 1,
  })
  const ended = held[0]
  if (!ended) throw new Error("No shard was claimed")
  await worker.backend.completeWorkflowRun({
    workflowRunId: ended.id,
    workerId: ended.workerId,
    output: null,
  })
  // The freed place goes to the shard of the second org, although the first
  // org's shards wait longer.
  const [next] = await worker.poll([c])
  expect(next?.id).toBe(otherShard)
})
