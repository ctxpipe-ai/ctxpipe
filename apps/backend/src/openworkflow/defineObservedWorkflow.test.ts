import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { defineWorkflow } from "./defineObservedWorkflow.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})

beforeAll(() => {
  provider.register()
})

afterAll(async () => {
  await provider.shutdown()
})

describe("defineObservedWorkflow", () => {
  it("rejects a schema that cannot carry telemetry", () => {
    expect(() =>
      defineWorkflow(
        { name: "bad-schema", schema: z.string() } as never,
        (async () => undefined) as never,
      ),
    ).toThrow(/object schema/)
  })

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
    expect(
      exporter
        .getFinishedSpans()
        .some((span) => span.name === "openworkflow.job widget-refresh"),
    ).toBe(true)
  })
})
