import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it } from "vitest"
import { workspaceMigrationExportRetired } from "./workspace-migration-export.js"

/*
 * A build from before upgrade step 1 can leave a queued run of the direct
 * export. The run is queued before the worker starts, as it is after a
 * deploy.
 */
let backend: BackendPostgres
let runner: OpenWorkflow
let worker: ReturnType<OpenWorkflow["newWorker"]>
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
})

afterAll(async () => {
  await worker?.stop()
  await backend?.stop()
})

it("ends a queued run of the retired migration export as retired, with no write", async () => {
  backend = await BackendPostgres.connect(process.env.DATABASE_URL ?? "", {
    runMigrations: false,
    namespaceId: `retired_migration_export_${suffix}`,
  })
  runner = new OpenWorkflow({ backend })
  runner.implementWorkflow(
    workspaceMigrationExportRetired.spec,
    workspaceMigrationExportRetired.fn,
  )
  // The input that an older build queued.
  const handle = await runner.runWorkflow(
    { name: "workspace-write-migration-export" },
    {
      orgId: "org_x",
      workspaceId: "ws_x",
      jobId: "wjob_x",
      kind: "migration_export",
    },
  )
  worker = runner.newWorker({ concurrency: 1 })
  await worker.start()
  expect(await handle.result({ timeoutMs: 20_000 })).toEqual({
    status: "retired",
  })
}, 30_000)
