import { initLogger } from "evlog"
import { OpenWorkflow, type Workflow } from "openworkflow"
import type { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it } from "vitest"
import { z } from "zod"

import { defineWorkflow } from "./defineObservedWorkflow.js"
import { connectOpenWorkflowBackend } from "./storable-backend.js"

// Postgres refuses a NUL character in a jsonb value. A step that fails with
// such text, or returns it, must still store its own error or output.
let backend: BackendPostgres
let ow: OpenWorkflow

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  backend = await connectOpenWorkflowBackend(process.env.DATABASE_URL)
  ow = new OpenWorkflow({ backend })
})

afterAll(async () => {
  await backend.stop()
})

const suffix = Math.random().toString(36).slice(2)
const once = { maximumAttempts: 1 }

async function runToEnd<Input, Output, Raw>(
  workflow: Workflow<Input, Output, Raw>,
) {
  ow.implementWorkflow(workflow.spec, workflow.fn)
  const worker = ow.newWorker({ concurrency: 1 })
  await worker.start()
  try {
    const handle = await ow.runWorkflow(workflow.spec, {} as Raw)
    const outcome = await handle.result({ timeoutMs: 30_000 }).then(
      (output) => ({ output, failure: undefined }),
      (error: Error) => ({ output: undefined, failure: error.message }),
    )
    const attempts = await backend.listStepAttempts({
      workflowRunId: handle.workflowRun.id,
    })
    return { ...outcome, steps: attempts.data }
  } finally {
    await worker.stop()
  }
}

it("stores the original step error when its message holds a NUL character", async () => {
  const workflow = defineWorkflow(
    {
      name: `nul-error-${suffix}`,
      schema: z.object({}),
      retryPolicy: once,
    },
    async ({ step }) =>
      step.run({ name: "read", retryPolicy: once }, () => {
        throw new TypeError("bad\u0000 byte in file")
      }),
  )
  const { failure, steps } = await runToEnd(workflow)

  expect(failure).toContain("bad byte in file")
  expect(failure).not.toContain("unsupported Unicode escape sequence")
  expect(steps[0]?.status).toBe("failed")
  expect(steps[0]?.error).toMatchObject({
    name: "TypeError",
    message: "bad byte in file",
  })
  expect(JSON.stringify(steps[0]?.error)).not.toContain("\\u0000")
})

it("stores a step output that holds a NUL character or a lone surrogate", async () => {
  const workflow = defineWorkflow(
    {
      name: `nul-output-${suffix}`,
      schema: z.object({}),
      retryPolicy: once,
    },
    async ({ step }) =>
      step.run({ name: "read", retryPolicy: once }, () => ({
        text: "a\u0000b",
        lone: "x\ud800y",
        nested: [{ "k\u0000ey": "v\u0000" }],
        count: 3,
        flag: true,
        none: null,
      })),
  )
  const { output, failure } = await runToEnd(workflow)

  expect(failure).toBeUndefined()
  expect(output).toEqual({
    text: "ab",
    lone: "x�y",
    nested: [{ key: "v" }],
    count: 3,
    flag: true,
    none: null,
  })
})

it("stores the error of a workflow body that holds a NUL character", async () => {
  const workflow = defineWorkflow(
    {
      name: `nul-body-${suffix}`,
      schema: z.object({}),
      retryPolicy: once,
    },
    async () => {
      throw new Error("body\u0000 failed")
    },
  )
  const { failure } = await runToEnd(workflow)

  expect(failure).toContain("body failed")
  expect(failure).not.toContain("unsupported Unicode escape sequence")
})

// OpenWorkflow writes a failed heartbeat only to `console.error`. The
// backend logs it with the run and the worker (CTX-1080).
it("logs a lease extension that fails because the worker does not own the run", async () => {
  const events: Array<Record<string, unknown>> = []
  initLogger({
    pretty: false,
    silent: true,
    env: { service: "ctxpipe-backend-test" },
    drain: (ctx) => {
      events.push(ctx.event as Record<string, unknown>)
    },
  })
  try {
    const workflow = defineWorkflow(
      { name: `lease-${suffix}`, schema: z.object({}), retryPolicy: once },
      async () => "done",
    )
    ow.implementWorkflow(workflow.spec, workflow.fn)
    // No worker claims the run: the stale worker does not own it.
    const handle = await ow.runWorkflow(workflow.spec, {})
    const params = {
      workflowRunId: handle.workflowRun.id,
      workerId: "stale-worker",
      leaseDurationMs: 30_000,
    }
    await expect(backend.extendWorkflowRunLease(params)).rejects.toThrow(
      "Failed to extend lease for workflow run",
    )
    expect(
      events.filter((e) => e.step === "openworkflow.lease_extend_failed"),
    ).toEqual([
      expect.objectContaining({
        level: "warn",
        workflowRunId: handle.workflowRun.id,
        workerId: "stale-worker",
      }),
    ])
    await handle.cancel()
  } finally {
    initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  }
})
