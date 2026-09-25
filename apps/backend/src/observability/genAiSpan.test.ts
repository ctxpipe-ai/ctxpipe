import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { ChatOpenAI } from "@langchain/openai"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { genAiProviderName, installChatOpenAiGenAiSpans } from "./genAiChat.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
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
      await chat.invoke("hi")
      await new Promise((resolve) => setTimeout(resolve, 30))
      const span = exporter
        .getFinishedSpans()
        .find((item) =>
          Object.keys(item.attributes).some((key) => key.startsWith("gen_ai")),
        )
      expect(span?.instrumentationScope.name).toBe("ctxpipe-genai")
      expect(span?.attributes).toMatchObject({
        "gen_ai.system": "openrouter",
        "gen_ai.provider.name": "openrouter",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-test",
        "gen_ai.response.model": "gpt-test",
        "gen_ai.usage.input_tokens": 3,
        "gen_ai.usage.output_tokens": 2,
      })
    } finally {
      if (previous === undefined) delete process.env.MODEL_PROVIDER
      else process.env.MODEL_PROVIDER = previous
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  })
})
