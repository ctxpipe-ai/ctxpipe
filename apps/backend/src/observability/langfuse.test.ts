import { propagateAttributes, startActiveObservation } from "@langfuse/tracing"
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { applyAttribution, contextWithAttributionBag } from "./attribution.js"
import {
  collapseRepeatedModelName,
  runWithLangfuseContext,
} from "./langfuse.js"
import { LangfuseContextSpanProcessor } from "./langfuseContextProcessor.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    new LangfuseContextSpanProcessor(),
    new SimpleSpanProcessor(exporter),
  ],
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

describe("collapseRepeatedModelName", () => {
  it("collapses a model name concatenated by streaming chunk merge", () => {
    expect(
      collapseRepeatedModelName("openai/gpt-5.6-terraopenai/gpt-5.6-terra"),
    ).toBe("openai/gpt-5.6-terra")
    expect(collapseRepeatedModelName("openai/gpt-5.6-terra")).toBe(
      "openai/gpt-5.6-terra",
    )
  })
})

describe("Langfuse context attributes", () => {
  it("copies userId, sessionId, tags, and trace metadata onto the root span", async () => {
    const parent = trace.getTracer("test").startSpan("http")
    const { context: withBag } = contextWithAttributionBag(
      trace.setSpan(ROOT_CONTEXT, parent),
    )
    await context.with(withBag, async () => {
      applyAttribution({
        "ctxpipe.org.id": "org_1",
        "ctxpipe.org.slug": "acme",
        "request.id": "req_lf",
        "ctxpipe.actor.type": "user",
        "enduser.id": "user_1",
      })
      await runWithLangfuseContext(
        {
          userId: "user_1",
          sessionId: "thr_1",
          tags: ["mcp"],
          traceMetadata: { workflow: "advisor" },
        },
        async () => {
          await propagateAttributes(
            {
              userId: "user_1",
              sessionId: "thr_1",
              tags: [
                "mcp",
                "org:acme",
                `env:${process.env.RAILWAY_ENVIRONMENT_NAME ?? "development"}`,
              ],
              metadata: {
                orgId: "org_1",
                requestId: "req_lf",
              },
            },
            () => {
              const observation = startActiveObservation(
                "advisor",
                (span) => span,
              )
              observation.end()
            },
          )
        },
      )
    })
    parent.end()

    const advisor = exporter
      .getFinishedSpans()
      .find((span) => span.name === "advisor")
    expect(advisor?.attributes["user.id"]).toBe("user_1")
    expect(advisor?.attributes["langfuse.user.id"]).toBe("user_1")
    expect(advisor?.attributes["session.id"]).toBe("thr_1")
    expect(advisor?.attributes["langfuse.session.id"]).toBe("thr_1")
    expect(advisor?.attributes["langfuse.trace.tags"]).toEqual(
      expect.arrayContaining(["mcp", "org:acme"]),
    )
    expect(advisor?.attributes["langfuse.trace.metadata.orgId"]).toBe("org_1")
    expect(advisor?.attributes["langfuse.trace.metadata.requestId"]).toBe(
      "req_lf",
    )
  })

  it("omits userId for org api key actors", async () => {
    const { context: withBag } = contextWithAttributionBag(ROOT_CONTEXT)
    await context.with(withBag, async () => {
      applyAttribution({
        "ctxpipe.actor.type": "org_api_key",
        "enduser.id": "should_not_stick",
        "ctxpipe.org.id": "org_1",
      })
      let seen: string | undefined = "unset"
      await runWithLangfuseContext(
        { userId: "should_not_stick", sessionId: "thr_org" },
        () => {
          seen = undefined
        },
      )
      expect(seen).toBeUndefined()
    })
  })
})
