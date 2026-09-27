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

  it("does not start a span when nothing is already tracing", async () => {
    const { runWorkflowWithWorkerWake } = await import("./client.js")
    const handle = await runWorkflowWithWorkerWake(enqueueProbe.spec, {
      orgId: "org_1",
    })
    await handle.cancel()
    expect(
      spans.spanNamed("openworkflow.enqueue observability-enqueue-probe"),
    ).toBeUndefined()
  })

  it("parents an enqueue span to the active span", async () => {
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
    const enqueue = spans.spanNamed(
      "openworkflow.enqueue observability-enqueue-probe",
    )
    expect(enqueue?.kind).toBe(SpanKind.PRODUCER)
    expect(enqueue?.parentSpanContext?.spanId).toBe(
      request?.spanContext().spanId,
    )
    expect(enqueue?.parentSpanContext?.traceId).toBe(
      request?.spanContext().traceId,
    )
    expect(enqueue?.attributes).toMatchObject({
      "messaging.system": "openworkflow",
      "messaging.operation.type": "send",
      "messaging.destination.name": "observability-enqueue-probe",
    })
    const traceparent = (
      handle.workflowRun.input as {
        telemetry?: { carrier?: { traceparent?: string } }
      } | null
    )?.telemetry?.carrier?.traceparent
    expect(traceparent?.split("-")[1]).toBe(enqueue?.spanContext().traceId)
    expect(traceparent?.split("-")[2]).toBe(enqueue?.spanContext().spanId)
    expect(traceparent?.split("-")[2]).not.toBe(request?.spanContext().spanId)
    await handle.cancel()
  })
})
