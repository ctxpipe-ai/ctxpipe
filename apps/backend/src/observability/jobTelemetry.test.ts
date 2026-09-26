import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { beforeEach, describe, expect, it } from "vitest"
import { recordSpans } from "../../test/spans.js"
import { applyAttribution, contextWithAttributionBag } from "./attribution.js"
import {
  attachJobTelemetry,
  captureJobTelemetry,
  restoreJobTelemetry,
} from "./jobTelemetry.js"
import { createLogger, loggerStorage } from "./logger.js"

const spans = recordSpans()

beforeEach(() => {
  loggerStorage.enterWith(createLogger({}))
})

describe("job telemetry", () => {
  it("links the job span and copies request id; org comes from the input", async () => {
    const tracer = trace.getTracer("test")
    const parent = tracer.startSpan("request")
    const parentContext = trace.setSpan(context.active(), parent)
    const { context: withBag } = contextWithAttributionBag(parentContext)
    const input = await context.with(withBag, async () => {
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
      expect(telemetry).not.toHaveProperty("ctxpipe.org.id")
      expect(telemetry).not.toHaveProperty("ctxpipe.org.slug")
      expect(telemetry).toMatchObject({
        "request.id": "req_job",
        "enduser.id": "user_1",
      })
      const attached = attachJobTelemetry({
        repositoryId: "repo_1",
        orgId: "org_1",
        orgSlug: "acme",
      })
      expect(attached.telemetry).toEqual(telemetry)

      await restoreJobTelemetry(
        attached,
        { name: "widget-refresh" },
        async () => {
          expect(trace.getActiveSpan()?.spanContext().spanId).not.toBe(
            parent.spanContext().spanId,
          )
        },
      )
      return attached
    })
    parent.end()

    const job = spans.spanNamed("openworkflow.job widget-refresh")
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
      spans.spanNamed("request")?.attributes["ctxpipe.repository.id"],
    ).toBeUndefined()
    expect(input.telemetry).not.toHaveProperty("ctxpipe.org.id")
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
      expect(first.telemetry).not.toHaveProperty("ctxpipe.org.id")
      expect(first.telemetry).not.toHaveProperty("ctxpipe.org.slug")
      expect(second.telemetry).not.toHaveProperty("ctxpipe.org.id")
      expect(second.telemetry).not.toHaveProperty("ctxpipe.repository.id")
    })
    parent.end()
    const request = spans.spanNamed("request")
    expect(request?.attributes["ctxpipe.repository.id"]).toBeUndefined()
    expect(request?.attributes["ctxpipe.connection.id"]).toBeUndefined()
    expect(request?.attributes["ctxpipe.actor.type"]).toBe("user")
    expect(request?.attributes["ctxpipe.org.id"]).toBe("org_caller")
  })

  it("starts a job span for background enqueue with actor job and org id", async () => {
    await restoreJobTelemetry(
      { orgId: "org_bg", connectionId: "con_bg" },
      { name: "background-refresh" },
      async () => {
        expect(trace.getActiveSpan()?.spanContext().spanId).toBeTruthy()
      },
    )
    const job = spans.spanNamed("openworkflow.job background-refresh")
    expect(job?.kind).toBe(SpanKind.CONSUMER)
    expect(job?.attributes).toMatchObject({
      "ctxpipe.actor.type": "job",
      "ctxpipe.org.id": "org_bg",
      "ctxpipe.connection.id": "con_bg",
    })
  })

  it("lets each job's org and connection come from that job's input", async () => {
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
      })
      expect(first.telemetry).not.toHaveProperty("ctxpipe.org.id")
      expect(first.telemetry).not.toHaveProperty("ctxpipe.org.slug")
      expect(second.telemetry).not.toHaveProperty("ctxpipe.org.id")
      expect(second.telemetry).not.toHaveProperty("ctxpipe.org.slug")
      await restoreJobTelemetry(
        first,
        { name: "alpha-run" },
        async () => undefined,
      )
      await restoreJobTelemetry(
        second,
        { name: "beta-run" },
        async () => undefined,
      )
    })
    parent.end()

    const jobs = spans
      .finishedSpans()
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
    const webhook = spans.spanNamed("webhook")
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
      restoreJobTelemetry(undefined, { name: "widget-refresh" }, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    const sleep = new Error("SleepSignal")
    sleep.name = "SleepSignal"
    await expect(
      restoreJobTelemetry(undefined, { name: "widget-refresh" }, async () => {
        throw sleep
      }),
    ).rejects.toBe(sleep)

    const retry = new Error("step failed")
    retry.name = "StepError"
    Object.assign(retry, {
      stepFailedAttempts: 1,
      retryPolicy: { maximumAttempts: 10 },
      originalError: new Error("db down"),
    })
    await expect(
      restoreJobTelemetry(undefined, { name: "widget-refresh" }, async () => {
        throw retry
      }),
    ).rejects.toBe(retry)

    const exhausted = new Error("step failed")
    exhausted.name = "StepError"
    Object.assign(exhausted, {
      stepFailedAttempts: 10,
      retryPolicy: { maximumAttempts: 10 },
      originalError: new Error("db down"),
    })
    await expect(
      restoreJobTelemetry(undefined, { name: "widget-refresh" }, async () => {
        throw exhausted
      }),
    ).rejects.toBe(exhausted)

    const jobs = spans
      .finishedSpans()
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
})
