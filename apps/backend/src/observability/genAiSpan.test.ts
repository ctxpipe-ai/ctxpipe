import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { ChatOpenAI } from "@langchain/openai"
import { propagateAttributes } from "@langfuse/tracing"
import { context, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { genAiProviderName, installChatOpenAiGenAiSpans } from "./genAiChat.js"
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
  installChatOpenAiGenAiSpans()
})

afterAll(async () => {
  await provider.shutdown()
})

describe("genAiProviderName", () => {
  it("uses MODEL_PROVIDER and otherwise the model id prefix", () => {
    const previous = process.env.MODEL_PROVIDER
    try {
      process.env.MODEL_PROVIDER = "openrouter"
      expect(genAiProviderName("openai/gpt-5.6-terra")).toBe("openrouter")
      process.env.MODEL_PROVIDER = "openai-like"
      expect(genAiProviderName("openai/gpt-5.6-terra")).toBe("openai")
      delete process.env.MODEL_PROVIDER
      expect(genAiProviderName("gpt-test")).toBe("openai")
    } finally {
      if (previous === undefined) delete process.env.MODEL_PROVIDER
      else process.env.MODEL_PROVIDER = previous
    }
  })
})

describe("ChatOpenAI gen_ai spans", () => {
  it("emits a ctxpipe-genai span for ChatOpenAI without a second process", async () => {
    const previous = process.env.MODEL_PROVIDER
    process.env.MODEL_PROVIDER = "openrouter"
    const server = createServer((req, res) => {
      req.on("data", () => {})
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: "gpt-test",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    try {
      const port = (server.address() as AddressInfo).port
      const chat = new ChatOpenAI({
        model: "gpt-test",
        apiKey: "test-not-a-real-key",
        streaming: false,
        configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
      })
      const parent = trace.getTracer("test").startSpan("caller")
      await context.with(trace.setSpan(context.active(), parent), async () => {
        await propagateAttributes(
          {
            userId: "user_1",
            sessionId: "thr_1",
            tags: ["mcp"],
            metadata: { orgId: "org_1" },
          },
          () => chat.invoke("SECRET_PROMPT_DO_NOT_RECORD"),
        )
      })
      parent.end()
      await new Promise((resolve) => setTimeout(resolve, 30))
      const genAiSpans = exporter
        .getFinishedSpans()
        .filter((item) => item.instrumentationScope.name === "ctxpipe-genai")
      expect(genAiSpans).toHaveLength(1)
      const span = genAiSpans[0]
      expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
      expect(span?.instrumentationScope.name).toBe("ctxpipe-genai")
      expect(span?.attributes).toMatchObject({
        "gen_ai.system": "openrouter",
        "gen_ai.provider.name": "openrouter",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-test",
        "gen_ai.response.model": "gpt-test",
        "gen_ai.usage.input_tokens": 3,
        "gen_ai.usage.output_tokens": 2,
        "gen_ai.response.finish_reason": "stop",
        "user.id": "user_1",
        "langfuse.user.id": "user_1",
        "session.id": "thr_1",
        "langfuse.session.id": "thr_1",
      })
      expect(span?.attributes["langfuse.trace.tags"]).toEqual(
        expect.arrayContaining(["mcp"]),
      )
      expect(span?.attributes["langfuse.trace.metadata.orgId"]).toBe("org_1")
      expect(JSON.stringify(span?.attributes)).not.toContain(
        "SECRET_PROMPT_DO_NOT_RECORD",
      )
    } finally {
      if (previous === undefined) delete process.env.MODEL_PROVIDER
      else process.env.MODEL_PROVIDER = previous
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  })
})
