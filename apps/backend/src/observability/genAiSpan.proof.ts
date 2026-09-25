import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
provider.register()

const { installChatOpenAiGenAiSpans } = await import("./genAiChat.js")
installChatOpenAiGenAiSpans()
const { ChatOpenAI } = await import("@langchain/openai")

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
const port = (server.address() as AddressInfo).port
const chat = new ChatOpenAI({
  model: "gpt-test",
  apiKey: "test-not-a-real-key",
  streaming: false,
  configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
})
await chat.invoke("hi")
await new Promise((resolve) => setTimeout(resolve, 30))
const spans = exporter.getFinishedSpans().map((span) => ({
  name: span.name,
  attributes: span.attributes,
}))
await provider.shutdown()
await new Promise<void>((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()))
})

const genAi = spans.filter((span) =>
  Object.keys(span.attributes).some((key) => key.startsWith("gen_ai")),
)
if (genAi.length === 0) {
  console.error(JSON.stringify({ ok: false, spans }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, genAi }, null, 2))
