import { SpanStatusCode } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { OpenWorkflow } from "openworkflow"
import { BackendSqlite } from "openworkflow/sqlite"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { recordSpans } from "../../test/spans.js"
import { readAttribution } from "../observability/attribution.js"
import { defineWorkflow } from "./defineObservedWorkflow.js"

const spans = recordSpans()

describe("defineObservedWorkflow", () => {
  it("names the job span after the workflow", async () => {
    const workflow = defineWorkflow(
      { name: "widget-refresh", schema: z.object({ orgId: z.string() }) },
      async () => "ok",
    )
    await expect(
      workflow.fn({
        input: { orgId: "org_1" },
        step: {} as never,
        version: null,
        run: {} as never,
      }),
    ).resolves.toBe("ok")
    expect(spans.spanNamed("openworkflow.job widget-refresh")).toBeDefined()
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

    const childSpan = spans.spanNamed("openworkflow.job child-sync")
    const link = childSpan?.links[0]?.context
    const linkedParent = spans
      .finishedSpans()
      .find(
        (span) =>
          span.name === "openworkflow.job parent-sync" &&
          span.spanContext().spanId === link?.spanId &&
          span.spanContext().traceId === link?.traceId,
      )
    expect(linkedParent).toBeDefined()
    expect(childSpan?.attributes).toMatchObject({
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
      spans.spanNamed("openworkflow.job child-no-slug")?.attributes,
    ).toMatchObject({
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
    await worker.start()
    try {
      const handle = await ow.runWorkflow(workflow.spec, { orgId: "org_1" })
      const execute = await waitForSpan(
        (span) =>
          span.name === "workflow_run.execute" &&
          span.attributes["openworkflow.workflow.name"] ===
            "native-trace-sleep",
      )
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
      expect(
        execute.links.some(
          (link) =>
            link.context.spanId === create?.spanContext().spanId &&
            link.context.traceId === create?.spanContext().traceId,
        ),
      ).toBe(true)
      expect(
        spans
          .finishedSpans()
          .some(
            (span) =>
              span.name === "step_attempt.execute" &&
              span.attributes["openworkflow.step.name"] === "read-org" &&
              span.attributes["openworkflow.run.id"] === handle.workflowRun.id,
          ),
      ).toBe(true)
      expect(
        spans
          .finishedSpans()
          .some(
            (span) =>
              span.name === "step_attempt.execute" &&
              span.attributes["openworkflow.step.name"] === "pause",
          ),
      ).toBe(false)
      expect(execute.attributes["openworkflow.execution.outcome"]).toBe(
        "suspended",
      )
      expect(execute.status.code).toBe(SpanStatusCode.UNSET)
      await handle.cancel()
    } finally {
      await worker.stop()
      await backend.stop()
    }
  }, 20_000)
})

async function waitForSpan(
  match: (span: ReadableSpan) => boolean,
): Promise<ReadableSpan> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const found = spans.finishedSpans().find(match)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("timed out waiting for an OpenWorkflow span")
}
