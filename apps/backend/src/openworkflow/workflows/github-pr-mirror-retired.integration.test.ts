import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it } from "vitest"

import {
  githubEnsurePrMirrorRetired,
  githubSyncContentRetired,
  syncGithubRepositoriesRetired,
} from "./github-pr-mirror-retired.js"

/*
 * A previous version can leave a queued run of a retired workflow. The run is
 * queued before the worker starts, as it is after a deploy.
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

it("ends a queued run of each retired workflow as retired", async () => {
  backend = await BackendPostgres.connect(process.env.DATABASE_URL ?? "", {
    runMigrations: false,
    namespaceId: `retired_workflows_${suffix}`,
  })
  runner = new OpenWorkflow({ backend })
  const retired = [
    syncGithubRepositoriesRetired,
    githubEnsurePrMirrorRetired,
    githubSyncContentRetired,
  ]
  for (const workflow of retired) {
    runner.implementWorkflow(workflow.spec, workflow.fn)
  }
  const handle = await runner.runWorkflow(syncGithubRepositoriesRetired.spec, {
    orgId: "org_x",
    githubConnectionId: "con_x",
    reposToSync: [{ id: 1 }],
  })
  worker = runner.newWorker({ concurrency: 1 })
  await worker.start()
  expect(await handle.result({ timeoutMs: 20_000 })).toEqual({
    status: "retired",
  })
}, 30_000)
