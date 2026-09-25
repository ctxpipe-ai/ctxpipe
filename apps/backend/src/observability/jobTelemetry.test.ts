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
    expect(
      exporter.getFinishedSpans().find((span) => span.name === "request")
        ?.attributes["ctxpipe.repository.id"],
    ).toBeUndefined()
  })

  it("does not copy the job repository or connection onto the caller span", async () => {
    const tracer = trace.getTracer("test")
    const parent = tracer.startSpan("request")
    const parentContext = trace.setSpan(context.active(), parent)
    const { context: withBag } = contextWithAttributionBag(parentContext)
    await context.with(withBag, async () => {
      applyAttribution({
        "request.id": "req_job",
        "ctxpipe.actor.type": "user",
        "ctxpipe.org.id": "org_caller",
      })
      const first = attachJobTelemetry({
        repositoryId: "repo_first",
        connectionId: "con_first",
        orgId: "org_job",
      })
      const second = attachJobTelemetry({
        repositoryId: "repo_second",
        connectionId: "con_second",
        orgId: "org_other",
      })
      expect(first.telemetry?.["ctxpipe.org.id"]).toBe("org_caller")
      expect(second.telemetry).not.toHaveProperty("ctxpipe.repository.id")
    })
    parent.end()
    const request = exporter
      .getFinishedSpans()
      .find((span) => span.name === "request")
    expect(request?.attributes["ctxpipe.repository.id"]).toBeUndefined()
    expect(request?.attributes["ctxpipe.connection.id"]).toBeUndefined()
    expect(request?.attributes["ctxpipe.actor.type"]).toBe("user")
    expect(request?.attributes["ctxpipe.org.id"]).toBe("org_caller")
  })

  it("starts a job span for background enqueue with actor job and org id", async () => {
    await restoreJobTelemetry(
      undefined,
      async () => {
        expect(trace.getActiveSpan()?.spanContext().spanId).toBeTruthy()
      },
      { orgId: "org_bg", connectionId: "con_bg" },
    )
    const job = exporter
      .getFinishedSpans()
      .find((span) => span.name === "openworkflow.job")
    expect(job?.kind).toBe(SpanKind.CONSUMER)
    expect(job?.attributes).toMatchObject({
      "ctxpipe.actor.type": "job",
      "ctxpipe.org.id": "org_bg",
      "ctxpipe.connection.id": "con_bg",
    })
  })
})
