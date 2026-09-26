import {
  context,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics"
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
import { createLogger, loggerStorage } from "./logger.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
const metricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
)
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
})
const meterProvider = new MeterProvider({ readers: [metricReader] })

beforeAll(() => {
  provider.register()
  metrics.setGlobalMeterProvider(meterProvider)
})

beforeEach(() => {
  exporter.reset()
  loggerStorage.enterWith(createLogger({}))
})

afterAll(async () => {
  await provider.shutdown()
  await meterProvider.shutdown()
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
      expect(telemetry?.carrier?.traceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
      )
      expect(telemetry).not.toHaveProperty("traceparent")
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

      await restoreJobTelemetry(
        telemetry,
        async () => {
          expect(trace.getActiveSpan()?.spanContext().spanId).not.toBe(
            parent.spanContext().spanId,
          )
        },
        { repositoryId: "repo_1", orgId: "org_1" },
        "widget-refresh",
      )
    })
    parent.end()

    const job = exporter
      .getFinishedSpans()
      .find((span) => span.name === "openworkflow.job widget-refresh")
    expect(job?.kind).toBe(SpanKind.CONSUMER)
    expect(job?.spanContext().traceId).not.toBe(parent.spanContext().traceId)
    expect(job?.parentSpanContext?.spanId).toBeUndefined()
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
      expect(first.telemetry?.["ctxpipe.org.id"]).toBe("org_job")
      expect(first.telemetry?.["ctxpipe.org.slug"]).toBeUndefined()
      expect(second.telemetry?.["ctxpipe.org.id"]).toBe("org_other")
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
      "background-refresh",
    )
    const job = exporter
      .getFinishedSpans()
      .find((span) => span.name === "openworkflow.job background-refresh")
    expect(job?.kind).toBe(SpanKind.CONSUMER)
    expect(job?.attributes).toMatchObject({
      "ctxpipe.actor.type": "job",
      "ctxpipe.org.id": "org_bg",
      "ctxpipe.connection.id": "con_bg",
    })
  })

  it("lets each job's org and connection override a shared request bag", async () => {
    const tracer = trace.getTracer("test")
    const parent = tracer.startSpan("webhook")
    const parentContext = trace.setSpan(context.active(), parent)
    const { context: withBag } = contextWithAttributionBag(parentContext)
    await context.with(withBag, async () => {
      applyAttribution({
        "request.id": "req_wh",
        "ctxpipe.actor.type": "webhook",
        "ctxpipe.org.id": "org_last",
        "ctxpipe.org.slug": "last-org",
        "ctxpipe.connection.id": "con_last",
      })
      const first = attachJobTelemetry({
        orgId: "org_a",
        connectionId: "con_a",
      })
      const second = attachJobTelemetry({
        orgId: "org_b",
        orgSlug: "org-b",
        connectionId: "con_b",
      })
      expect(first.telemetry).toMatchObject({
        "request.id": "req_wh",
        "ctxpipe.org.id": "org_a",
      })
      expect(first.telemetry).not.toHaveProperty("ctxpipe.org.slug")
      expect(second.telemetry).toMatchObject({
        "ctxpipe.org.id": "org_b",
        "ctxpipe.org.slug": "org-b",
      })
      await restoreJobTelemetry(
        first.telemetry,
        async () => undefined,
        {
          orgId: "org_a",
          connectionId: "con_a",
        },
        "alpha-run",
      )
      await restoreJobTelemetry(
        second.telemetry,
        async () => undefined,
        {
          orgId: "org_b",
          orgSlug: "org-b",
          connectionId: "con_b",
        },
        "beta-run",
      )
    })
    parent.end()

    const jobs = exporter
      .getFinishedSpans()
      .filter((span) => span.name.startsWith("openworkflow.job "))
    expect(jobs.map((span) => span.name)).toEqual([
      "openworkflow.job alpha-run",
      "openworkflow.job beta-run",
    ])
    expect(jobs.map((span) => span.attributes["ctxpipe.org.id"])).toEqual([
      "org_a",
      "org_b",
    ])
    expect(
      jobs.map((span) => span.attributes["ctxpipe.connection.id"]),
    ).toEqual(["con_a", "con_b"])
    expect(jobs[0]?.attributes["ctxpipe.org.slug"]).toBeUndefined()
    expect(jobs[1]?.attributes["ctxpipe.org.slug"]).toBe("org-b")
    expect(jobs[0]?.attributes["ctxpipe.actor.type"]).toBe("job")
    const webhook = exporter
      .getFinishedSpans()
      .find((span) => span.name === "webhook")
    expect(webhook?.attributes["ctxpipe.org.id"]).toBe("org_last")
    expect(webhook?.attributes["ctxpipe.connection.id"]).toBe("con_last")
  })

  it("returns non-object enqueue input unchanged", () => {
    expect(attachJobTelemetry(undefined)).toBeUndefined()
    expect(attachJobTelemetry(null)).toBeNull()
    expect(attachJobTelemetry("plain")).toBe("plain")
    expect(attachJobTelemetry([1, 2])).toEqual([1, 2])
  })

  it("records a failure and leaves sleep and retry scheduling unmarked", async () => {
    const failure = new Error("sync failed")
    await expect(
      restoreJobTelemetry(
        undefined,
        async () => {
          throw failure
        },
        undefined,
        "widget-refresh",
      ),
    ).rejects.toBe(failure)

    const sleep = new Error("SleepSignal")
    sleep.name = "SleepSignal"
    await expect(
      restoreJobTelemetry(
        undefined,
        async () => {
          throw sleep
        },
        undefined,
        "widget-refresh",
      ),
    ).rejects.toBe(sleep)

    const retry = new Error("step failed")
    retry.name = "StepError"
    Object.assign(retry, {
      stepFailedAttempts: 1,
      retryPolicy: { maximumAttempts: 10 },
      originalError: new Error("db down"),
    })
    await expect(
      restoreJobTelemetry(
        undefined,
        async () => {
          throw retry
        },
        undefined,
        "widget-refresh",
      ),
    ).rejects.toBe(retry)

    const exhausted = new Error("step failed")
    exhausted.name = "StepError"
    Object.assign(exhausted, {
      stepFailedAttempts: 10,
      retryPolicy: { maximumAttempts: 10 },
      originalError: new Error("db down"),
    })
    await expect(
      restoreJobTelemetry(
        undefined,
        async () => {
          throw exhausted
        },
        undefined,
        "widget-refresh",
      ),
    ).rejects.toBe(exhausted)

    const jobs = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "openworkflow.job widget-refresh")
    expect(jobs).toHaveLength(4)
    expect(jobs[0]?.status.code).toBe(SpanStatusCode.ERROR)
    expect(jobs[0]?.events.map((event) => event.name)).toContain("exception")
    expect(jobs[0]?.events[0]?.attributes?.["exception.message"]).toBe(
      "sync failed",
    )
    expect(jobs[1]?.status.code).toBe(SpanStatusCode.UNSET)
    expect(jobs[1]?.events).toHaveLength(0)
    expect(jobs[2]?.status.code).toBe(SpanStatusCode.UNSET)
    expect(jobs[2]?.events).toHaveLength(0)
    expect(jobs[3]?.status.code).toBe(SpanStatusCode.ERROR)
    expect(jobs[3]?.events[0]?.attributes?.["exception.message"]).toBe(
      "db down",
    )
  })

  it("marks fan-out enqueued from a job so that child is not a second sync", async () => {
    let nested: boolean | undefined
    await restoreJobTelemetry(
      undefined,
      async () => {
        const child = attachJobTelemetry({ orgId: "org_child" })
        nested = child.telemetry?.nested
        await restoreJobTelemetry(
          child.telemetry,
          async () => undefined,
          { orgId: "org_child" },
          "linear-sync-content",
          "linear",
        )
      },
      { orgId: "org_root" },
      "linear-sync-config",
      "linear",
    )
    expect(nested).toBe(true)
    await metricReader.forceFlush()
    const syncs = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name === "ctxpipe.connector.syncs")
    expect(syncs).toHaveLength(1)
    const data = syncs[0]?.dataPoints
    expect(syncs[0]?.dataPointType).toBe(DataPointType.SUM)
    expect(data).toEqual([
      expect.objectContaining({
        value: 1,
        attributes: {
          "ctxpipe.org.id": "org_root",
          "ctxpipe.connector.type": "linear",
          outcome: "success",
        },
      }),
    ])
    const child = exporter
      .getFinishedSpans()
      .find((span) => span.name === "openworkflow.job linear-sync-content")
    const root = exporter
      .getFinishedSpans()
      .find((span) => span.name === "openworkflow.job linear-sync-config")
    expect(child?.spanContext().traceId).not.toBe(root?.spanContext().traceId)
    expect(child?.links[0]?.context.spanId).toBe(root?.spanContext().spanId)
    expect(child?.attributes["request.id"]).toBeUndefined()
    expect(root?.attributes["ctxpipe.org.id"]).toBe("org_root")
  })
})
