import { SpanKind, trace } from "@opentelemetry/api"
import { afterAll, expect, it } from "vitest"
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
})
