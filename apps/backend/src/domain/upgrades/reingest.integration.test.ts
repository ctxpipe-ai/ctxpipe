import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { closeDb, initDb } from "../../db/client.js"
import { generateObjectId } from "../../lib/id.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../ingestion/ingestion-run.js"
import {
  ingestionRunState,
  reingestRunKey,
  takeReingestSlot,
} from "./reingest.js"

/*
 * The re-ingestion throttle with real Postgres and real OpenWorkflow runs.
 * No worker runs here, so each queued ingestion v2 run stays `pending`
 * (active) until the test cancels it.
 */

let backend: BackendPostgres
let runner: OpenWorkflow
const spec = {
  name: INGESTION_V2_WORKFLOW_NAME,
  schema: z.object({ orgId: z.string() }).passthrough(),
}
const queued: string[] = []

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required for this test")
  initDb(databaseUrl)
  backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  runner = new OpenWorkflow({ backend })
})

afterAll(async () => {
  for (const id of queued)
    await runner.cancelWorkflowRun(id).catch(() => undefined)
  await backend?.stop()
  await closeDb()
})

/** Take a slot; a free slot queues a real pending ingestion v2 run. */
async function take(input: {
  orgId: string
  workspaceId: string
  repository: string
  runsPerInstance?: number
}) {
  const key = reingestRunKey({ ...input, upgradeRunId: "run_fixture" })
  return takeReingestSlot({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    key,
    runsPerInstance: input.runsPerInstance,
    start: async () => {
      const handle = await runner.runWorkflow(
        spec,
        { orgId: input.orgId },
        { idempotencyKey: key },
      )
      queued.push(handle.workflowRun.id)
      return handle.workflowRun.id
    },
  })
}

describe("re-ingestion throttle", () => {
  it("runs one Workspace of an org and one repository at a time, and frees the slot when the run ends", async () => {
    const orgId = generateObjectId("org")
    const [a, b] = [generateObjectId("ws"), generateObjectId("ws")]
    const first = await take({
      orgId,
      workspaceId: a,
      repository: "acme/one",
    })
    expect(first).toEqual({ runId: expect.any(String) })
    // The same run again: the same id, also while the slot is taken.
    expect(
      await take({ orgId, workspaceId: a, repository: "acme/one" }),
    ).toEqual(first)
    expect(
      await take({ orgId, workspaceId: a, repository: "acme/two" }),
    ).toEqual({ wait: "Another repository of this Workspace runs." })
    expect(
      await take({ orgId, workspaceId: b, repository: "acme/three" }),
    ).toEqual({
      wait: "A re-ingestion of another Workspace of this organization runs.",
    })
    // Another org is not held by this org.
    expect(
      await take({
        orgId: generateObjectId("org"),
        workspaceId: generateObjectId("ws"),
        repository: "acme/one",
      }),
    ).toEqual({ runId: expect.any(String) })

    if (!("runId" in first)) throw new Error("expected a run")
    expect(await ingestionRunState(first.runId)).toEqual({ done: false })
    await runner.cancelWorkflowRun(first.runId)
    expect(await ingestionRunState(first.runId)).toMatchObject({
      done: true,
      status: "canceled",
    })
    expect(
      await take({ orgId, workspaceId: b, repository: "acme/three" }),
    ).toEqual({ runId: expect.any(String) })
  })

  it("caps the runs of the instance", async () => {
    // The runs of the test above that are still active count too.
    const active = async () => {
      let count = 0
      for (const id of queued) if (!(await ingestionRunState(id)).done) count++
      return count
    }
    const cap = (await active()) + 1
    const orgs = [generateObjectId("org"), generateObjectId("org")]
    expect(
      await take({
        orgId: orgs[0] ?? "",
        workspaceId: generateObjectId("ws"),
        repository: "acme/one",
        runsPerInstance: cap,
      }),
    ).toEqual({ runId: expect.any(String) })
    expect(
      await take({
        orgId: orgs[1] ?? "",
        workspaceId: generateObjectId("ws"),
        repository: "acme/one",
        runsPerInstance: cap,
      }),
    ).toEqual({ wait: "The re-ingestion slots of this instance are full." })
  })
})
