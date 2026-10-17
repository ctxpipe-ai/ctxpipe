import { defineWorkflowSpec, OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it } from "vitest"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import {
  cancelOpenWorkflowRuns,
  cancelWorkflowRunIfOpen,
} from "./open-workflow-runs.js"

const databaseUrl = process.env.DATABASE_URL ?? ""
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
let fileBackend: BackendPostgres
let otherBackend: BackendPostgres

beforeAll(async () => {
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  fileBackend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  otherBackend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: `test-other-${suffix}`,
  })
})

afterAll(async () => {
  await fileBackend.stop()
  await otherBackend.stop()
})

it("gives the file its own namespace", () => {
  expect(openWorkflowNamespaceId()).toMatch(/^test-/)
  expect(openWorkflowNamespaceId()).not.toBe("default")
})

it("cancels the open runs of one namespace, and no other run", async () => {
  const spec = defineWorkflowSpec({ name: `open-runs-${suffix}` })
  const run = (backend: BackendPostgres) =>
    new OpenWorkflow({ backend }).runWorkflow(spec, {})
  const open = await run(fileBackend)
  const other = await run(otherBackend)

  expect(
    await cancelOpenWorkflowRuns(databaseUrl, openWorkflowNamespaceId()),
  ).toContain(open.workflowRun.id)

  const status = async (backend: BackendPostgres, id: string) =>
    (await backend.getWorkflowRun({ workflowRunId: id }))?.status
  expect(await status(fileBackend, open.workflowRun.id)).toBe("canceled")
  expect(await status(otherBackend, other.workflowRun.id)).toBe("pending")
  await new OpenWorkflow({ backend: otherBackend }).cancelWorkflowRun(
    other.workflowRun.id,
  )
})

it("treats the cancel of a run that completed first as done, and keeps other errors", async () => {
  const ow = new OpenWorkflow({ backend: fileBackend })
  const spec = defineWorkflowSpec({ name: `completes-${suffix}` })
  ow.implementWorkflow(spec, async () => "done")
  const handle = await ow.runWorkflow(spec, {})
  const worker = ow.newWorker({ concurrency: 1 })
  await worker.start()
  try {
    expect(await handle.result({ timeoutMs: 30_000 })).toBe("done")
  } finally {
    await worker.stop()
  }
  const id = handle.workflowRun.id
  // The run completed between the read of its status and the cancel.
  await expect(ow.cancelWorkflowRun(id)).rejects.toThrow(
    "with status completed",
  )

  await expect(cancelWorkflowRunIfOpen(fileBackend, id)).resolves.toBe(
    undefined,
  )
  expect(
    (await fileBackend.getWorkflowRun({ workflowRunId: id }))?.status,
  ).toBe("completed")
  await expect(
    cancelWorkflowRunIfOpen(fileBackend, crypto.randomUUID()),
  ).rejects.toThrow("does not exist")
})
