import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { contextWithAttributionBag } from "./attribution.js"
import { withLlmGeneration } from "./llm-spans.js"
import { AttributionUrlSpanProcessor } from "./otel.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    new AttributionUrlSpanProcessor(),
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

function generation(name: string) {
  return exporter.getFinishedSpans().find((span) => span.name === name)
}

describe("withLlmGeneration", () => {
  it("records an embedding call with the model, the input, and the output summary", async () => {
    await withLlmGeneration(
      {
        name: "modelProvider.generateEmbeddings",
        operation: "embeddings",
        model: "openai/text-embedding-3-large",
        provider: "openai-like",
        input: { textCount: 2, totalCharacters: 2 },
        summarizeOutput: () => ({ embeddingCount: 2 }),
      },
      async () => [0.1, 0.2],
    )
    const span = generation("modelProvider.generateEmbeddings")
    expect(span?.attributes).toMatchObject({
      "gen_ai.operation.name": "embeddings",
      "gen_ai.request.model": "openai/text-embedding-3-large",
      "gen_ai.provider.name": "openai-like",
    })
    expect(
      JSON.parse(String(span?.attributes["gen_ai.input.messages"])),
    ).toEqual({ textCount: 2, totalCharacters: 2 })
    expect(
      JSON.parse(String(span?.attributes["gen_ai.output.messages"])),
    ).toEqual({ embeddingCount: 2 })
    expect(span?.attributes["gen_ai.usage.cost"]).toBeUndefined()
    expect(span?.status.code).toBe(SpanStatusCode.UNSET)
  })

  it("puts the gateway cost and the tokens on the span, under the gen_ai keys", async () => {
    await withLlmGeneration(
      {
        name: "modelProvider.chat",
        operation: "chat",
        model: "openai/gpt-test",
        input: { messages: [] },
        summarizeOutput: () => ({ text: "ok" }),
        usageFromResult: () => ({ input: 10, output: 5, cost: 0.0123 }),
      },
      async () => "ok",
    )
    expect(generation("modelProvider.chat")?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cost": 0.0123,
    })
  })

  it("gives a failed call an error status with the message and keeps the usage so far", async () => {
    await expect(
      withLlmGeneration(
        {
          name: "modelProvider.generateEmbeddings",
          operation: "embeddings",
          input: { textCount: 3 },
          summarizeOutput: () => ({}),
          usageSoFar: () => ({ input: 7, cost: 0.002 }),
        },
        async () => {
          throw new Error("Embedding failed: 500")
        },
      ),
    ).rejects.toThrow("Embedding failed: 500")
    const span = generation("modelProvider.generateEmbeddings")
    expect(span?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "Embedding failed: 500",
    })
    expect(span?.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.cost": 0.002,
    })
    expect(span?.attributes["gen_ai.output.messages"]).toBeUndefined()
  })

  it("copies the attribution of the request onto the span and makes it the parent of the provider spans", async () => {
    const { context: withBag, bag } = contextWithAttributionBag(ROOT_CONTEXT)
    await context.with(withBag, async () => {
      bag.set("ctxpipe.org.id", "org_1")
      bag.set("ctxpipe.org.slug", "acme")
      bag.set("request.id", "req_embed")
      await withLlmGeneration(
        {
          name: "modelProvider.generateEmbeddings",
          operation: "embeddings",
          input: { textCount: 1 },
          summarizeOutput: () => ({ embeddingCount: 1 }),
        },
        async () => {
          trace.getTracer("test").startSpan("POST /embeddings").end()
          return [0.1]
        },
      )
    })
    const span = generation("modelProvider.generateEmbeddings")
    expect(span?.attributes).toMatchObject({
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
      "request.id": "req_embed",
    })
    expect(generation("POST /embeddings")?.parentSpanContext?.spanId).toBe(
      span?.spanContext().spanId,
    )
  })
})
