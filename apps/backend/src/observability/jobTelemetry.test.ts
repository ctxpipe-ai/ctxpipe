import { context, SpanKind, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { applyAttribution, contextWithAttributionBag } from "./attribution.js"
import {
  attachJobTelemetry,
  captureJobTelemetry,
  restoreJobTelemetry,
} from "./jobTelemetry.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => {
  provider.register()
})

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  await provider.shutdown()
})

describe("job telemetry", () => {
  it("round-trips traceparent, request id, and org id onto a linked job span", async () => {
    const tracer = trace.getTracer("test")
    const parent = tracer.startSpan("request")
    const parentContext = trace.setSpan(context.active(), parent)
    const { context: withBag } = contextWithAttributionBag(parentContext)
    await context.with(withBag, async () => {
      applyAttribution({
        "request.id": "req_job",
        "enduser.id": "user_1",
        "ctxpipe.org.id": "org_1",
        "ctxpipe.org.slug": "acme",
        "ctxpipe.actor.type": "user",
      })
      const telemetry = captureJobTelemetry()
      expect(telemetry?.traceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
      )
      expect(telemetry).toMatchObject({
        "request.id": "req_job",
        "enduser.id": "user_1",
        "ctxpipe.org.id": "org_1",
        "ctxpipe.org.slug": "acme",
      })
      const input = attachJobTelemetry({
        repositoryId: "repo_1",
        orgId: "org_1",
      })
      expect(input.telemetry).toEqual(telemetry)

      await restoreJobTelemetry(telemetry, async () => {
        expect(trace.getActiveSpan()?.spanContext().spanId).not.toBe(
          parent.spanContext().spanId,
        )
      })
    })
    parent.end()

    const job = exporter
      .getFinishedSpans()
      .find((span) => span.name === "openworkflow.job")
    expect(job?.kind).toBe(SpanKind.CONSUMER)
    expect(job?.links[0]?.context.traceId).toBe(parent.spanContext().traceId)
    expect(job?.links[0]?.context.spanId).toBe(parent.spanContext().spanId)
    expect(job?.attributes).toMatchObject({
      "ctxpipe.actor.type": "job",
      "request.id": "req_job",
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
    })
  })
})
