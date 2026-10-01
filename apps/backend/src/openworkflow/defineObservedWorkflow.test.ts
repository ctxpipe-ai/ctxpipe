import { SpanStatusCode } from "@opentelemetry/api"
import { OpenWorkflow } from "openworkflow"
import { BackendSqlite } from "openworkflow/sqlite"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { recordSpans } from "../../test/spans.js"
import { readAttribution } from "../observability/attribution.js"
import { defineWorkflow } from "./defineObservedWorkflow.js"

const spans = recordSpans()

describe("defineObservedWorkflow", () => {
  it("restores job attribution without starting a span", async () => {
    const workflow = defineWorkflow(
      { name: "widget-refresh", schema: z.object({ orgId: z.string() }) },
      async () => readAttribution(),
    )
    await expect(
      workflow.fn({
        input: { orgId: "org_1" },
        step: {} as never,
        version: null,
        run: {} as never,
      }),
    ).resolves.toMatchObject({
      "ctxpipe.actor.type": "job",
      "ctxpipe.org.id": "org_1",
    })
    expect(
      spans
        .finishedSpans()
        .some((span) => span.name.startsWith("openworkflow.job")),
    ).toBe(false)
  })

  it("gives a child run the parent attribution and a link to the parent span", async () => {
    const child = defineWorkflow(
      {
        name: "child-sync",
        schema: z.object({ orgId: z.string(), orgSlug: z.string() }),
      },
      async () => readAttribution(),
    )
    const parent = defineWorkflow(
      {
        name: "parent-sync",
        schema: z.object({ orgId: z.string(), orgSlug: z.string() }),
      },
      async ({ input, step }) => {
        const org = await step.run({ name: "read-org" }, () => ({
          orgId: input.orgId,
          orgSlug: input.orgSlug,
        }))
        return step.runWorkflow(
          child.spec,
          { orgId: org.orgId, orgSlug: org.orgSlug },
          { name: "child" },
        )
      },
    )

    const backend = BackendSqlite.connect(":memory:")
    const ow = new OpenWorkflow({ backend })
    ow.implementWorkflow(child.spec, child.fn)
    ow.implementWorkflow(parent.spec, parent.fn)
    const worker = ow.newWorker({ concurrency: 4 })
    await worker.start()
    try {
      const handle = await ow.runWorkflow(parent.spec, {
        orgId: "org_1",
        orgSlug: "acme",
        telemetry: {
          "enduser.id": "user_9",
          "request.id": "req_1",
        },
      })
      await expect(handle.result({ timeoutMs: 15_000 })).resolves.toMatchObject(
        {
          "ctxpipe.actor.type": "job",
          "ctxpipe.org.id": "org_1",
          "ctxpipe.org.slug": "acme",
          "enduser.id": "user_9",
          "request.id": "req_1",
        },
      )
    } finally {
      await worker.stop()
      await backend.stop()
    }

    const childExecute = spans
      .finishedSpans()
      .find(
        (span) =>
          span.name === "workflow_run.execute" &&
          span.attributes["openworkflow.workflow.name"] === "child-sync",
      )
    const childCreate = spans
      .finishedSpans()
      .find(
        (span) =>
          span.name === "workflow_run.create" &&
          span.attributes["openworkflow.workflow.name"] === "child-sync",
      )
    const parentExecute = spans
      .finishedSpans()
      .find(
        (span) =>
          span.name === "workflow_run.execute" &&
          span.attributes["openworkflow.workflow.name"] === "parent-sync",
      )
    expect(childCreate?.parentSpanContext?.spanId).toBe(
      parentExecute?.spanContext().spanId,
    )
    expect(childCreate?.spanContext().traceId).toBe(
      parentExecute?.spanContext().traceId,
    )
    expect(childExecute?.parentSpanContext).toBeUndefined()
    expect(childExecute?.spanContext().traceId).not.toBe(
      parentExecute?.spanContext().traceId,
    )
    expect(childExecute?.spanContext().traceId).not.toBe(
      childCreate?.spanContext().traceId,
    )
    expect(
      childExecute?.links.some(
        (link) =>
          link.context.spanId === childCreate?.spanContext().spanId &&
          link.context.traceId === childCreate?.spanContext().traceId,
      ),
    ).toBe(true)
    expect(childExecute?.attributes).toMatchObject({
      "ctxpipe.actor.type": "job",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
      "enduser.id": "user_9",
      "request.id": "req_1",
    })
  }, 20_000)

  it("restores org slug on a child whose schema has no orgSlug", async () => {
    const child = defineWorkflow(
      {
        name: "child-no-slug",
        schema: z.object({ orgId: z.string() }),
      },
      async () => readAttribution(),
    )
    const parent = defineWorkflow(
      {
        name: "parent-with-slug",
        schema: z.object({ orgId: z.string(), orgSlug: z.string() }),
      },
      async ({ input, step }) =>
        step.runWorkflow(child.spec, { orgId: input.orgId }, { name: "child" }),
    )

    const backend = BackendSqlite.connect(":memory:")
    const ow = new OpenWorkflow({ backend })
    ow.implementWorkflow(child.spec, child.fn)
    ow.implementWorkflow(parent.spec, parent.fn)
    const worker = ow.newWorker({ concurrency: 4 })
    await worker.start()
    try {
      const handle = await ow.runWorkflow(parent.spec, {
        orgId: "org_1",
        orgSlug: "acme",
      })
      await expect(handle.result({ timeoutMs: 15_000 })).resolves.toMatchObject(
        {
          "ctxpipe.actor.type": "job",
          "ctxpipe.org.id": "org_1",
          "ctxpipe.org.slug": "acme",
        },
      )
    } finally {
      await worker.stop()
      await backend.stop()
    }

    expect(
      spans
        .finishedSpans()
        .find(
          (span) =>
            span.name === "workflow_run.execute" &&
            span.attributes["openworkflow.workflow.name"] === "child-no-slug",
        )?.attributes,
    ).toMatchObject({
      "ctxpipe.actor.type": "job",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
    })
  }, 20_000)

  it("links the execution span to creation and suspends a sleep without a step span", async () => {
    const workflow = defineWorkflow(
      {
        name: "native-trace-sleep",
        schema: z.object({ orgId: z.string() }),
      },
      async ({ step }) => {
        await step.run({ name: "read-org" }, async () => "ok")
        await step.sleep("pause", "1h")
        return "done"
      },
    )

    const backend = BackendSqlite.connect(":memory:")
    const ow = new OpenWorkflow({ backend })
    ow.implementWorkflow(workflow.spec, workflow.fn)
    const worker = ow.newWorker({ concurrency: 1 })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const handle = await ow.runWorkflow(workflow.spec, { orgId: "org_1" })
      await worker.start()
      const execute = await vi.waitFor(() => {
        const span = spans
          .finishedSpans()
          .find(
            (candidate) =>
              candidate.name === "workflow_run.execute" &&
              candidate.attributes["openworkflow.workflow.name"] ===
                "native-trace-sleep",
          )
        if (!span) throw new Error("execution span not finished")
        return span
      })
      const create = spans
        .finishedSpans()
        .find(
          (span) =>
            span.name === "workflow_run.create" &&
            span.attributes["openworkflow.run.id"] === handle.workflowRun.id,
        )
      expect(create?.attributes["openworkflow.workflow.name"]).toBe(
        "native-trace-sleep",
      )
      expect(execute.parentSpanContext).toBeUndefined()
      expect(execute.spanContext().traceId).not.toBe(
        create?.spanContext().traceId,
      )
      expect(
        execute.links.some(
          (link) =>
            link.context.spanId === create?.spanContext().spanId &&
            link.context.traceId === create?.spanContext().traceId,
        ),
      ).toBe(true)
      const step = spans
        .finishedSpans()
        .find(
          (span) =>
            span.name === "step_attempt.execute" &&
            span.attributes["openworkflow.step.name"] === "read-org" &&
            span.attributes["openworkflow.run.id"] === handle.workflowRun.id,
        )
      expect(step?.parentSpanContext?.spanId).toBe(execute.spanContext().spanId)
      expect(step?.spanContext().traceId).toBe(execute.spanContext().traceId)
      expect(step?.attributes["ctxpipe.actor.type"]).toBe("job")
      expect(step?.attributes["ctxpipe.org.id"]).toBe("org_1")
      expect(
        spans
          .finishedSpans()
          .some(
            (span) =>
              span.name === "step_attempt.execute" &&
              span.attributes["openworkflow.step.name"] === "pause",
          ),
      ).toBe(false)
      expect(
        spans
          .finishedSpans()
          .some((span) => span.name.startsWith("openworkflow.job")),
      ).toBe(false)
      expect(execute.attributes["openworkflow.execution.outcome"]).toBe(
        "suspended",
      )
      expect(execute.attributes["ctxpipe.actor.type"]).toBe("job")
      expect(execute.attributes["ctxpipe.org.id"]).toBe("org_1")
      expect(execute.status.code).toBe(SpanStatusCode.UNSET)
      await handle.cancel()
    } finally {
      await worker.stop()
      await backend.stop()
      vi.useRealTimers()
    }
  }, 20_000)

  it("omits drizzle params from a failed step and its execution span", async () => {
    const workflow = defineWorkflow(
      {
        name: "native-trace-db-error",
        schema: z.object({ orgId: z.string() }),
      },
      async ({ step }) => {
        await step.run(
          {
            name: "write-row",
            retryPolicy: {
              maximumAttempts: 1,
              initialInterval: "1s",
              backoffCoefficient: 1,
              maximumInterval: "1s",
            },
          },
          async () => {
            throw new Error(
              'Failed query: insert into "repositories" ("git_url") values ($1)\nparams: user@example.com token=SECRET',
            )
          },
        )
      },
    )

    const backend = BackendSqlite.connect(":memory:")
    const ow = new OpenWorkflow({ backend })
    ow.implementWorkflow(workflow.spec, workflow.fn)
    const worker = ow.newWorker({ concurrency: 1 })
    await worker.start()
    try {
      const handle = await ow.runWorkflow(workflow.spec, { orgId: "org_1" })
      await expect(handle.result({ timeoutMs: 15_000 })).rejects.toThrow(
        /Failed query:/,
      )
    } finally {
      await worker.stop()
      await backend.stop()
    }

    const recorded = spans.finishedSpans().filter((span) => {
      return (
        span.attributes["openworkflow.workflow.name"] ===
          "native-trace-db-error" &&
        (span.name === "workflow_run.execute" ||
          span.name === "step_attempt.execute")
      )
    })
    expect(recorded.map((span) => span.name).sort()).toEqual([
      "step_attempt.execute",
      "workflow_run.execute",
    ])
    const dumped = JSON.stringify(
      recorded.map((span) => ({
        status: span.status.message,
        events: span.events,
        attributes: span.attributes,
      })),
    )
    expect(dumped).not.toContain("params:")
    expect(dumped).not.toContain("user@example.com")
    expect(dumped).not.toContain("token=SECRET")
    expect(dumped).toContain("Failed query:")
    const step = recorded.find((span) => span.name === "step_attempt.execute")
    expect(step?.attributes["ctxpipe.org.id"]).toBe("org_1")
    expect(step?.attributes["ctxpipe.actor.type"]).toBe("job")
    expect(step?.parentSpanContext?.spanId).toBe(
      recorded
        .find((span) => span.name === "workflow_run.execute")
        ?.spanContext().spanId,
    )
  }, 20_000)
})
