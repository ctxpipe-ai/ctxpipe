import { OpenWorkflow } from "openworkflow"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { z } from "zod"

import { cancelOpenWorkflowRuns } from "../test/open-workflow-runs.js"
import { defineWorkflow } from "./defineObservedWorkflow.js"
import { connectOpenWorkflowBackend } from "./storable-backend.js"

// A preview database is a copy of production, so it holds the open workflow
// runs of production. The preview also starts with the production variables,
// OPENWORKFLOW_NAMESPACE_ID included. Its worker must not run those copies:
// they would act on production data twice (for example, push to a customer
// repository) with the preview's code and keys.
let databaseUrl: string

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  databaseUrl = process.env.DATABASE_URL
})

afterEach(() => {
  vi.unstubAllEnvs()
})

it("a preview worker on a copy of production does not run the copied production workflows", async () => {
  const suffix = Math.random().toString(36).slice(2)
  const ran: string[] = []
  const once = { maximumAttempts: 1 }
  const workflow = defineWorkflow(
    {
      name: `copied-run-${suffix}`,
      schema: z.object({ origin: z.string() }),
      retryPolicy: once,
    },
    async ({ input, step }) =>
      step.run({ name: "act", retryPolicy: once }, () => {
        ran.push(input.origin)
        return input.origin
      }),
  )

  // Production enqueued this run before the copy. No production worker runs
  // in this test, so the run stays pending in the shared rows.
  vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "production")
  const production = await connectOpenWorkflowBackend(databaseUrl)
  const copied = await new OpenWorkflow({ backend: production }).runWorkflow(
    workflow.spec,
    { origin: "production" },
  )

  // The preview has the same variables and its own deployment name.
  const pr = `pr-${100_000 + Math.floor(Math.random() * 900_000)}`
  vi.stubEnv("DEPLOYMENT_ENVIRONMENT", pr)
  const preview = await connectOpenWorkflowBackend(databaseUrl)
  const ow = new OpenWorkflow({ backend: preview })
  ow.implementWorkflow(workflow.spec, workflow.fn)
  const worker = ow.newWorker({ concurrency: 1 })
  await worker.start()
  try {
    // The preview worker runs a run of its own, so it does claim work.
    const own = await ow.runWorkflow(workflow.spec, { origin: "preview" })
    await expect(own.result({ timeoutMs: 30_000 })).resolves.toBe("preview")
    // One more poll interval, for a late claim of the copied run.
    await new Promise((settle) => setTimeout(settle, 1_500))

    expect(ran).toEqual(["preview"])
    const row = await production.getWorkflowRun({
      workflowRunId: copied.workflowRun.id,
    })
    expect(row?.status).toBe("pending")
    expect(row?.workerId).toBeNull()
  } finally {
    await worker.stop()
    await cancelOpenWorkflowRuns(databaseUrl, `preview-${pr}`)
    await preview.stop()
    await production.stop()
  }
})
