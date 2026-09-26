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
      { name: "child-sync", schema: z.object({ orgId: z.string() }) },
      async () => readAttribution(),
    )
    const parent = defineWorkflow(
      {
        name: "parent-sync",
        schema: z.object({ orgId: z.string() }),
        connectorType: "linear",
      },
      async ({ input, step }) => {
        const orgId = await step.run({ name: "read-org" }, () => input.orgId)
        return step.runWorkflow(child.spec, { orgId }, { name: "child" })
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
        telemetry: {
          "ctxpipe.org.id": "org_1",
          "ctxpipe.org.slug": "acme",
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
})
