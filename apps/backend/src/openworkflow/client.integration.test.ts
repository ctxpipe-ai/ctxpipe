import { SpanKind, trace } from "@opentelemetry/api"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { defineWorkflow as defineRawWorkflow } from "openworkflow"
import { afterAll, expect, it, vi } from "vitest"
import { z } from "zod"

import { describeWithDatabase } from "../../test/db.js"
import { recordSpans } from "../../test/spans.js"
import { defineWorkflow } from "./defineObservedWorkflow.js"

const spans = recordSpans()

const enqueueProbe = defineWorkflow(
  {
    name: "observability-enqueue-probe",
    schema: z.object({ orgId: z.string() }),
  },
  async () => "ok",
)

const rawStrictProbe = defineRawWorkflow(
  {
    name: "observability-enqueue-raw-strict-probe",
    schema: z.object({ orgId: z.string() }).strict(),
  },
  async () => "ok",
)

describeWithDatabase("runWorkflowWithWorkerWake", () => {
  afterAll(async () => {
    const { closeOpenWorkflowClient } = await import("./client.js")
    await closeOpenWorkflowClient()
  })

  it("starts workflow_run.create on its own trace when nothing is already tracing", async () => {
    const { runWorkflowWithWorkerWake } = await import("./client.js")
    const handle = await runWorkflowWithWorkerWake(enqueueProbe.spec, {
      orgId: "org_1",
    })
    await handle.cancel()
    expect(
      spans.spanNamed("openworkflow.enqueue observability-enqueue-probe"),
    ).toBeUndefined()
    const create = spans.spanNamed("workflow_run.create")
    expect(create?.kind).toBe(SpanKind.PRODUCER)
    expect(create?.parentSpanContext).toBeUndefined()
    expect(create?.attributes).toMatchObject({
      "openworkflow.workflow.name": "observability-enqueue-probe",
      "openworkflow.run.id": handle.workflowRun.id,
    })
  })

  it("parents workflow_run.create to the active span", async () => {
    const { runWorkflowWithWorkerWake } = await import("./client.js")
    const handle = await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("POST /repositories", async (request) => {
        const queued = await runWorkflowWithWorkerWake(enqueueProbe.spec, {
          orgId: "org_1",
        })
        request.end()
        return queued
      })
    const request = spans.spanNamed("POST /repositories")
    const create = spans.spanNamed("workflow_run.create")
    expect(create?.kind).toBe(SpanKind.PRODUCER)
    expect(create?.parentSpanContext?.spanId).toBe(
      request?.spanContext().spanId,
    )
    expect(create?.parentSpanContext?.traceId).toBe(
      request?.spanContext().traceId,
    )
    expect(create?.attributes).toMatchObject({
      "openworkflow.workflow.name": "observability-enqueue-probe",
      "openworkflow.run.id": handle.workflowRun.id,
    })
    await handle.cancel()
  })

  it("enqueues a raw strict-schema workflow while a request span is active", async () => {
    const { runWorkflowWithWorkerWake } = await import("./client.js")
    const handle = await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("POST /hydrate", async (request) => {
        const queued = await runWorkflowWithWorkerWake(rawStrictProbe.spec, {
          orgId: "org_1",
        })
        request.end()
        return queued
      })
    expect(handle.workflowRun.input).toEqual({ orgId: "org_1" })
    await handle.cancel()
  })
  it("does not wake the worker for a repeated key of a finished run", async () => {
    let deploys = 0
    const server = setupServer(
      http.post(
        "https://backboard.railway.com/graphql/v2",
        async ({ request }) => {
          const body = (await request.json()) as { query: string }
          if (body.query.includes("serviceInstanceDeployV2")) {
            deploys += 1
            return HttpResponse.json({
              data: { serviceInstanceDeployV2: true },
            })
          }
          return HttpResponse.json({
            data: {
              project: {
                services: {
                  edges: [{ node: { id: "svc_worker", name: "openworkflow" } }],
                },
              },
            },
          })
        },
      ),
    )
    server.listen({ onUnhandledRequest: "bypass" })
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-1")
    vi.stubEnv("RAILWAY_TOKEN", "railway-token")
    vi.stubEnv("RAILWAY_PROJECT_ID", "project_1")
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "environment_1")
    // Only Date is fake, so the test can step past the wake debounce.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
    try {
      const { runWorkflowWithWorkerWake } = await import("./client.js")
      const idempotencyKey = `wake-probe:${Math.random().toString(36).slice(2)}`
      const first = await runWorkflowWithWorkerWake(
        enqueueProbe.spec,
        { orgId: "org_1" },
        { idempotencyKey },
      )
      // A new run is pending, so it wakes the worker.
      await vi.waitFor(() => expect(deploys).toBe(1))
      await first.cancel()

      // Step past the wake debounce. The same key returns the finished run.
      vi.setSystemTime(Date.now() + 10 * 60_000)
      const repeated = await runWorkflowWithWorkerWake(
        enqueueProbe.spec,
        { orgId: "org_1" },
        { idempotencyKey },
      )
      expect(repeated.workflowRun.id).toBe(first.workflowRun.id)
      expect(repeated.workflowRun.status).not.toBe("pending")
      await new Promise((settle) => setTimeout(settle, 300))
      expect(deploys).toBe(1)
    } finally {
      vi.useRealTimers()
      vi.unstubAllEnvs()
      server.close()
    }
  })
})
