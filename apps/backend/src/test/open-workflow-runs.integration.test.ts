import { defineWorkflowSpec, OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it } from "vitest"
import { cancelOpenWorkflowRunsSince } from "./open-workflow-runs.js"

const databaseUrl = process.env.DATABASE_URL ?? ""
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
let defaultBackend: BackendPostgres
let otherBackend: BackendPostgres

beforeAll(async () => {
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  defaultBackend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
  })
  otherBackend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: `test-${suffix}`,
  })
})

afterAll(async () => {
  await defaultBackend.stop()
  await otherBackend.stop()
})

it("cancels the open default-namespace runs created since a time, and no other run", async () => {
  const spec = defineWorkflowSpec({ name: `open-runs-${suffix}` })
  const run = (backend: BackendPostgres) =>
    new OpenWorkflow({ backend }).runWorkflow(spec, {})
  const before = await run(defaultBackend)
  // Use the database clock: the host clock can differ from it.
  const since = new Date(before.workflowRun.createdAt.getTime() + 1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const open = await run(defaultBackend)
  const other = await run(otherBackend)

  expect(await cancelOpenWorkflowRunsSince(databaseUrl, since)).toContain(
    open.workflowRun.id,
  )

  const status = async (backend: BackendPostgres, id: string) =>
    (await backend.getWorkflowRun({ workflowRunId: id }))?.status
  expect(await status(defaultBackend, open.workflowRun.id)).toBe("canceled")
  expect(await status(defaultBackend, before.workflowRun.id)).toBe("pending")
  expect(await status(otherBackend, other.workflowRun.id)).toBe("pending")
  await new OpenWorkflow({ backend: defaultBackend }).cancelWorkflowRun(
    before.workflowRun.id,
  )
  await new OpenWorkflow({ backend: otherBackend }).cancelWorkflowRun(
    other.workflowRun.id,
  )
})
