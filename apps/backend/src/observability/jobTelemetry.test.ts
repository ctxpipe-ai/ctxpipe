import { context, trace } from "@opentelemetry/api"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { recordSpans } from "../../test/spans.js"
import {
  applyAttribution,
  contextWithAttributionBag,
  readAttribution,
} from "./attribution.js"
import {
  attachJobTelemetry,
  attachJobTelemetryForSchema,
  restoreJobTelemetry,
} from "./jobTelemetry.js"
import { createLogger, loggerStorage } from "./logger.js"

const spans = recordSpans()

/** `applyAttribution` writes to the request/job logger, so tests scope one. */
function withJobLogger<T>(fn: () => T): T {
  return loggerStorage.run({ logger: createLogger({}), base: {} }, fn)
}

describe("job telemetry", () => {
  it("stamps job attribution on the active execution span", () =>
    withJobLogger(async () => {
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
        const attached = attachJobTelemetry({
          repositoryId: "repo_1",
          orgId: "org_1",
          orgSlug: "acme",
        })
        expect(attached.telemetry).not.toHaveProperty("carrier")
        expect(attached.telemetry).toEqual({
          "request.id": "req_job",
          "enduser.id": "user_1",
          "ctxpipe.org.id": "org_1",
          "ctxpipe.org.slug": "acme",
        })

        const execution = tracer.startSpan("workflow_run.execute")
        await context.with(trace.setSpan(context.active(), execution), () =>
          restoreJobTelemetry(attached, async () => {
            expect(trace.getActiveSpan()?.spanContext().spanId).toBe(
              execution.spanContext().spanId,
            )
            expect(readAttribution()).toMatchObject({
              "ctxpipe.actor.type": "job",
              "ctxpipe.repository.id": "repo_1",
            })
          }),
        )
        execution.end()
        return attached
      })
      parent.end()

      expect(
        spans
          .finishedSpans()
          .some((span) => span.name.startsWith("openworkflow.job")),
      ).toBe(false)
      expect(spans.spanNamed("workflow_run.execute")?.attributes).toMatchObject(
        {
          "ctxpipe.actor.type": "job",
          "request.id": "req_job",
          "enduser.id": "user_1",
          "ctxpipe.org.id": "org_1",
          "ctxpipe.org.slug": "acme",
          "ctxpipe.repository.id": "repo_1",
        },
      )
      expect(
        spans.spanNamed("request")?.attributes["ctxpipe.repository.id"],
      ).toBeUndefined()
      expect(input.telemetry).toMatchObject({
        "ctxpipe.org.id": "org_1",
        "ctxpipe.org.slug": "acme",
      })
    }))

  it("does not copy the job repository or connection onto the caller span", () =>
    withJobLogger(async () => {
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
        expect(first.telemetry).toMatchObject({
          "ctxpipe.org.id": "org_caller",
        })
        expect(first.telemetry).not.toHaveProperty("ctxpipe.org.slug")
        expect(second.telemetry).toMatchObject({
          "ctxpipe.org.id": "org_caller",
        })
        expect(second.telemetry).not.toHaveProperty("ctxpipe.repository.id")
      })
      parent.end()
      const request = spans.spanNamed("request")
      expect(request?.attributes["ctxpipe.repository.id"]).toBeUndefined()
      expect(request?.attributes["ctxpipe.connection.id"]).toBeUndefined()
      expect(request?.attributes["ctxpipe.actor.type"]).toBe("user")
      expect(request?.attributes["ctxpipe.org.id"]).toBe("org_caller")
    }))

  it("restores actor job and org id when nothing is already tracing", async () => {
    const seen = await restoreJobTelemetry(
      { orgId: "org_bg", connectionId: "con_bg" },
      async () => readAttribution(),
    )
    expect(seen).toMatchObject({
      "ctxpipe.actor.type": "job",
      "ctxpipe.org.id": "org_bg",
      "ctxpipe.connection.id": "con_bg",
    })
    expect(
      spans
        .finishedSpans()
        .some((span) => span.name.startsWith("openworkflow.job")),
    ).toBe(false)
  })

  it("copies workspace and repository ids from the job input onto the execution span", async () => {
    const execution = trace.getTracer("test").startSpan("workflow_run.execute")
    await context.with(trace.setSpan(context.active(), execution), () =>
      restoreJobTelemetry(
        {
          orgId: "org_ws",
          workspaceId: "ws_hydrate",
          repositoryId: "repo_ingest",
        },
        async () => undefined,
      ),
    )
    execution.end()
    expect(spans.spanNamed("workflow_run.execute")?.attributes).toMatchObject({
      "ctxpipe.actor.type": "job",
      "ctxpipe.org.id": "org_ws",
      "ctxpipe.workspace.id": "ws_hydrate",
      "ctxpipe.repository.id": "repo_ingest",
    })
  })

  it("drops telemetry a strict workflow schema would reject", () =>
    withJobLogger(() => {
      const strict = z.object({ orgId: z.string() }).strict()
      const loose = z.object({ orgId: z.string() })
      const { context: withBag } = contextWithAttributionBag(context.active())
      context.with(withBag, () => {
        applyAttribution({ "request.id": "req_schema" })
        expect(attachJobTelemetryForSchema(strict, { orgId: "org_1" })).toEqual(
          { orgId: "org_1" },
        )
        expect(
          attachJobTelemetryForSchema(loose, { orgId: "org_1" }),
        ).toMatchObject({ telemetry: { "request.id": "req_schema" } })
      })
    }))

  it("lets each job's org and connection come from that job's input", () =>
    withJobLogger(async () => {
      const tracer = trace.getTracer("test")
      const parent = tracer.startSpan("webhook")
      const parentContext = trace.setSpan(context.active(), parent)
      const { context: withBag } = contextWithAttributionBag(parentContext)
      const queued = await context.with(withBag, async () => {
        applyAttribution({
          "request.id": "req_wh",
          "ctxpipe.actor.type": "webhook",
          "ctxpipe.org.id": "org_last",
          "ctxpipe.org.slug": "last-org",
          "ctxpipe.connection.id": "con_last",
        })
        const matching = attachJobTelemetry({
          orgId: "org_last",
          connectionId: "con_a",
        })
        const mismatched = attachJobTelemetry({
          orgId: "org_b",
          connectionId: "con_b",
        })
        const explicit = attachJobTelemetry({
          orgId: "org_c",
          orgSlug: "from-input",
          connectionId: "con_c",
        })
        expect(matching.telemetry).toMatchObject({
          "request.id": "req_wh",
          "ctxpipe.org.id": "org_last",
          "ctxpipe.org.slug": "last-org",
        })
        expect(mismatched.telemetry).toMatchObject({
          "ctxpipe.org.id": "org_last",
          "ctxpipe.org.slug": "last-org",
        })
        return [
          ["alpha-run", matching],
          ["beta-run", mismatched],
          ["gamma-run", explicit],
        ] as const
      })
      // The worker starts workflow_run.execute before the job bag exists.
      for (const [name, input] of queued) {
        const execution = tracer.startSpan(name)
        await context.with(trace.setSpan(context.active(), execution), () =>
          restoreJobTelemetry(input, async () => undefined),
        )
        execution.end()
      }
      parent.end()

      const jobs = ["alpha-run", "beta-run", "gamma-run"].map((name) =>
        spans.spanNamed(name),
      )
      expect(jobs.map((span) => span?.attributes["ctxpipe.org.id"])).toEqual([
        "org_last",
        "org_b",
        "org_c",
      ])
      expect(
        jobs.map((span) => span?.attributes["ctxpipe.connection.id"]),
      ).toEqual(["con_a", "con_b", "con_c"])
      expect(jobs.map((span) => span?.attributes["ctxpipe.org.slug"])).toEqual([
        "last-org",
        undefined,
        "from-input",
      ])
      expect(jobs[0]?.attributes["ctxpipe.actor.type"]).toBe("job")
      const webhook = spans.spanNamed("webhook")
      expect(webhook?.attributes["ctxpipe.org.id"]).toBe("org_last")
      expect(webhook?.attributes["ctxpipe.connection.id"]).toBe("con_last")
    }))

  it("rethrows failures, sleep, and retry scheduling", async () => {
    const failure = new Error("sync failed")
    await expect(
      restoreJobTelemetry(undefined, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    const sleep = new Error("SleepSignal")
    sleep.name = "SleepSignal"
    await expect(
      restoreJobTelemetry(undefined, async () => {
        throw sleep
      }),
    ).rejects.toBe(sleep)

    const retry = new Error("step failed")
    retry.name = "StepError"
    await expect(
      restoreJobTelemetry(undefined, async () => {
        throw retry
      }),
    ).rejects.toBe(retry)

    expect(
      spans
        .finishedSpans()
        .some((span) => span.name.startsWith("openworkflow.job")),
    ).toBe(false)
  })

  it("carries the validator run id from enqueue to step spans and child jobs", async () => {
    const tracer = trace.getTracer("test")
    const { context: withBag, bag } = contextWithAttributionBag(
      context.active(),
    )
    bag.set("ctxpipe.validator.run_id", "val_run_1")
    const queued = context.with(withBag, () =>
      attachJobTelemetry({ orgId: "org_val", repositoryId: "repo_val" }),
    )
    expect(queued.telemetry).toEqual({
      "ctxpipe.validator.run_id": "val_run_1",
    })

    const execution = tracer.startSpan("workflow_run.execute")
    const child = await context.with(
      trace.setSpan(context.active(), execution),
      () =>
        restoreJobTelemetry(queued, async () => {
          tracer.startSpan("step_attempt.execute").end()
          return attachJobTelemetry({ orgId: "org_val", workspaceId: "ws_1" })
        }),
    )
    execution.end()

    expect(child.telemetry).toMatchObject({
      "ctxpipe.validator.run_id": "val_run_1",
    })
    for (const name of ["workflow_run.execute", "step_attempt.execute"]) {
      expect(spans.spanNamed(name)?.attributes).toMatchObject({
        "ctxpipe.validator.run_id": "val_run_1",
        "ctxpipe.repository.id": "repo_val",
      })
    }
  })
})
