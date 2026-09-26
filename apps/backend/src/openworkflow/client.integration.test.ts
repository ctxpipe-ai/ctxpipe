import { SpanKind, trace } from "@opentelemetry/api"
import { defineWorkflow } from "openworkflow"
import { afterAll, expect, it } from "vitest"
import { z } from "zod"
import { describeWithDatabase } from "../../test/db.js"
import { recordSpans } from "../../test/spans.js"

const spans = recordSpans()

const repositoryIngestion = defineWorkflow(
  {
    name: "repository-ingestion",
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
    const handle = await runWorkflowWithWorkerWake(repositoryIngestion.spec, {
      orgId: "org_1",
    })
    await handle.cancel()
    expect(
      spans.spanNamed("openworkflow.enqueue repository-ingestion"),
    ).toBeUndefined()
  })

  it("parents an enqueue span to the active span", async () => {
    const { runWorkflowWithWorkerWake } = await import("./client.js")
    const handle = await trace
      .getTracer("ctxpipe-backend")
      .startActiveSpan("POST /repositories", async (request) => {
        const queued = await runWorkflowWithWorkerWake(
          repositoryIngestion.spec,
          { orgId: "org_1" },
        )
        request.end()
        return queued
      })
    await handle.cancel()

    const request = spans.spanNamed("POST /repositories")
    const enqueue = spans.spanNamed("openworkflow.enqueue repository-ingestion")
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
      "messaging.destination.name": "repository-ingestion",
    })
  })
})
