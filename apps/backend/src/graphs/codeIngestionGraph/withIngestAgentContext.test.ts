import { HumanMessage } from "@langchain/core/messages"
import { FakeListChatModel } from "@langchain/core/utils/testing"
import { context, ROOT_CONTEXT } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { contextWithAttributionBag } from "../../observability/attribution.js"
import {
  runWithLangfuseContext,
  withLangfuseObservation,
} from "../../observability/langfuse.js"
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import { withIngestAgentContext } from "./withIngestAgentContext.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    "deployment.environment": "pr-7",
  }),
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

describe("withIngestAgentContext", () => {
  it("instruments the agent model as one child generation", async () => {
    const prompt = "ingest-prompt-token"
    const { context: withBag, bag } = contextWithAttributionBag(ROOT_CONTEXT)
    const result = await context.with(withBag, async () => {
      bag.set("ctxpipe.org.id", "org_1")
      bag.set("ctxpipe.org.slug", "acme")
      bag.set("ctxpipe.actor.type", "user")
      bag.set("enduser.id", "user_1")
      return runWithLangfuseContext(
        {
          userId: "user_1",
          sessionId: "repository-ingestion:wr_1",
          tags: ["repository-ingestion"],
          traceMetadata: {
            workflow: "repository-ingestion",
            workflowRunId: "wr_1",
          },
        },
        () =>
          withLangfuseObservation(
            {
              name: "repository-ingestion.root",
              metadata: { rootId: "src", workflowStepName: "root" },
            },
            () =>
              withIngestAgentContext(
                {
                  runName: "repository-ingestion.identify",
                  tags: ["repository-ingestion"],
                  metadata: {
                    rootId: "src",
                    workflowStepName: "identify:src",
                  },
                },
                async () => {
                  const model = new FakeListChatModel({ responses: ["ok"] })
                  await model.invoke([new HumanMessage(prompt)])
                  await model.invoke([new HumanMessage("second-call")])
                  return "ok"
                },
              ),
          ),
      )
    })

    expect(result).toBe("ok")
    const spans = exporter.getFinishedSpans()
    const root = spans.find((span) => span.name === "repository-ingestion.root")
    const gens = spans.filter(
      (span) => span.attributes["langfuse.observation.type"] === "generation",
    )
    expect(gens).toHaveLength(2)
    expect(
      gens.every(
        (span) => span.parentSpanContext?.spanId === root?.spanContext().spanId,
      ),
    ).toBe(true)
    expect(gens[0]?.attributes["user.id"]).toBe("user_1")
    expect(gens[0]?.attributes["session.id"]).toBe("repository-ingestion:wr_1")
    expect(gens[0]?.attributes["langfuse.trace.tags"]).toEqual(
      expect.arrayContaining(["repository-ingestion", "org:acme"]),
    )
    expect(gens[0]?.attributes["langfuse.trace.metadata.workflowRunId"]).toBe(
      "wr_1",
    )
    expect(root?.attributes["langfuse.observation.metadata.rootId"]).toBe("src")
    const promptKeys = Object.entries(gens[0]?.attributes ?? {})
      .filter(([, value]) => JSON.stringify(value)?.includes(prompt))
      .map(([key]) => key)
    expect(promptKeys).toEqual(["langfuse.observation.input"])
  })
})
