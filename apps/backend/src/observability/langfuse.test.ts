import { _mergeDicts, HumanMessage } from "@langchain/core/messages"
import { FakeListChatModel } from "@langchain/core/utils/testing"
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { contextWithAttributionBag } from "./attribution.js"
import {
  getLangfuseHandler,
  runWithLangfuseContext,
  withLangfuseGeneration,
  withLangfuseObservation,
} from "./langfuse.js"
import { LangfuseContextSpanProcessor } from "./langfuseContextProcessor.js"

const exporter = new InMemorySpanExporter()
const environment =
  process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
  (process.env.NODE_ENV === "production" ? "production" : "development")
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    "deployment.environment": environment,
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

class NamedChunkModel extends FakeListChatModel {
  override _createResponseChunk(
    text: string,
    generationInfo?: Record<string, unknown>,
  ) {
    const chunk = super._createResponseChunk(text, generationInfo)
    chunk.message.response_metadata = {
      ...chunk.message.response_metadata,
      model_name: "openai/gpt-5.6-terra",
    }
    return chunk
  }
}

function generations(): ReadableSpan[] {
  return exporter
    .getFinishedSpans()
    .filter(
      (span) => span.attributes["langfuse.observation.type"] === "generation",
    )
}

function keysContaining(span: ReadableSpan, needle: string): string[] {
  const keys = Object.entries(span.attributes)
    .filter(([, value]) => JSON.stringify(value)?.includes(needle))
    .map(([key]) => key)
  for (const event of span.events) {
    for (const [key, value] of Object.entries(event.attributes ?? {})) {
      if (JSON.stringify(value)?.includes(needle)) keys.push(`event:${key}`)
    }
  }
  return keys
}

describe("LangChain stream model names", () => {
  it("concatenates model_name in the installed @langchain/core merge", () => {
    expect(
      _mergeDicts(
        { model_name: "openai/gpt-5.6-terra" },
        { model_name: "openai/gpt-5.6-terra" },
      )?.model_name,
    ).toBe("openai/gpt-5.6-terraopenai/gpt-5.6-terra")
  })

  it("records one generation and collapses the streamed model name", async () => {
    const prompt = "secret-prompt-token"
    const model = new NamedChunkModel({ responses: ["Yo"] })
    await runWithLangfuseContext({ sessionId: "thr_stream" }, async () => {
      const chunks = []
      for await (const chunk of await model.stream([new HumanMessage(prompt)], {
        callbacks: [getLangfuseHandler()],
      })) {
        chunks.push(chunk)
      }
      expect(chunks.length).toBeGreaterThan(1)
    })

    const gens = generations()
    expect(gens).toHaveLength(1)
    const generation = gens[0]
    expect(generation?.attributes["langfuse.observation.model.name"]).toBe(
      "openai/gpt-5.6-terra",
    )
    expect(generation?.attributes["session.id"]).toBe("thr_stream")
    expect(generation?.instrumentationScope.name).toMatch(/langfuse/i)
    expect(keysContaining(generation as ReadableSpan, prompt)).toEqual([
      "langfuse.observation.input",
    ])
    expect(
      Object.keys(generation?.attributes ?? {}).some((key) =>
        key.startsWith("gen_ai."),
      ),
    ).toBe(false)
    expect(
      exporter
        .getFinishedSpans()
        .some((span) => span.instrumentationScope.name === "ctxpipe-genai"),
    ).toBe(false)
  })
})

describe("Langfuse context attributes", () => {
  it("copies userId, sessionId, tags, and metadata onto the observation", async () => {
    const parent = trace.getTracer("test").startSpan("http")
    const { context: withBag, bag } = contextWithAttributionBag(
      trace.setSpan(ROOT_CONTEXT, parent),
    )
    await context.with(withBag, async () => {
      bag.set("ctxpipe.org.id", "org_1")
      bag.set("ctxpipe.org.slug", "acme")
      bag.set("request.id", "req_lf")
      bag.set("ctxpipe.actor.type", "user")
      bag.set("enduser.id", "user_1")
      await runWithLangfuseContext(
        {
          userId: "user_1",
          sessionId: "thr_1",
          tags: ["mcp"],
          traceMetadata: { workflow: "advisor" },
        },
        () => withLangfuseObservation({ name: "advisor" }, async () => "ok"),
      )
    })
    parent.end()

    const advisor = exporter
      .getFinishedSpans()
      .find((span) => span.name === "advisor")
    expect(advisor?.attributes["user.id"]).toBe("user_1")
    expect(advisor?.attributes["session.id"]).toBe("thr_1")
    expect(advisor?.attributes["langfuse.trace.tags"]).toEqual(
      expect.arrayContaining(["mcp", "org:acme", `env:${environment}`]),
    )
    expect(advisor?.attributes["langfuse.trace.metadata.orgId"]).toBe("org_1")
    expect(advisor?.attributes["langfuse.trace.metadata.orgSlug"]).toBe("acme")
    expect(advisor?.attributes["langfuse.trace.metadata.requestId"]).toBe(
      "req_lf",
    )
    expect(advisor?.attributes["langfuse.trace.metadata.environment"]).toBe(
      environment,
    )
    expect(advisor?.attributes["langfuse.trace.metadata.workflow"]).toBe(
      "advisor",
    )
    expect(advisor?.attributes["langfuse.environment"]).toBeUndefined()
    expect(advisor?.resource.attributes["deployment.environment"]).toBe(
      environment,
    )
    const http = exporter
      .getFinishedSpans()
      .find((span) => span.name === "http")
    expect(http?.attributes["langfuse.environment"]).toBeUndefined()
  })

  it("omits userId for org api key actors", async () => {
    const { context: withBag, bag } = contextWithAttributionBag(ROOT_CONTEXT)
    await context.with(withBag, async () => {
      bag.set("ctxpipe.actor.type", "org_api_key")
      bag.set("enduser.id", "should_not_stick")
      bag.set("ctxpipe.org.id", "org_1")
      await runWithLangfuseContext(
        { userId: "should_not_stick", sessionId: "thr_org" },
        () => withLangfuseObservation({ name: "org-key" }, async () => "ok"),
      )
    })
    const span = exporter
      .getFinishedSpans()
      .find((finished) => finished.name === "org-key")
    expect(span?.attributes["user.id"]).toBeUndefined()
    expect(span?.attributes["session.id"]).toBe("thr_org")
    expect(span?.attributes["langfuse.trace.metadata.orgId"]).toBe("org_1")
  })

  it("records one generation per embedding call with model and summary output", async () => {
    await withLangfuseGeneration(
      {
        name: "modelProvider.generateEmbeddings",
        model: "openai/text-embedding-3-large",
        input: { textCount: 2, totalCharacters: 2 },
        metadata: { provider: "openai-like" },
        summarizeOutput: () => ({ embeddingCount: 2 }),
      },
      async () => [0.1, 0.2],
    )
    const gens = generations()
    expect(gens).toHaveLength(1)
    expect(gens[0]?.name).toBe("modelProvider.generateEmbeddings")
    expect(gens[0]?.attributes["langfuse.observation.model.name"]).toBe(
      "openai/text-embedding-3-large",
    )
    expect(gens[0]?.attributes["langfuse.observation.input"]).toContain(
      "textCount",
    )
    expect(gens[0]?.attributes["langfuse.observation.output"]).toContain(
      "embeddingCount",
    )
    expect(gens[0]?.attributes["langfuse.observation.cost_details"]).toBe(
      undefined,
    )
  })
})
