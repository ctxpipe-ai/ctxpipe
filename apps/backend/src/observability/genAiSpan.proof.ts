import { createServer } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { NodeSDK } from "@opentelemetry/sdk-node"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"

const exporter = new InMemorySpanExporter()
const sdk = new NodeSDK({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
      "@opentelemetry/instrumentation-http": { enabled: false },
      "@opentelemetry/instrumentation-undici": { enabled: false },
    }),
  ],
})
sdk.start()

const require = createRequire(import.meta.url)
const OpenAI = require("openai") as new (options: {
  apiKey: string
  baseURL: string
}) => {
  chat: {
    completions: {
      create(
        body: unknown,
      ): Promise<{ choices: { message: { content: string } }[] }>
    }
  }
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", (chunk) => chunks.push(chunk as Buffer))
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
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    )
  })
})

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve)
})
const port = (server.address() as AddressInfo).port
const client = new OpenAI({
  apiKey: "test-not-a-real-key",
  baseURL: `http://127.0.0.1:${port}/v1`,
})
await client.chat.completions.create({
  model: "gpt-test",
  messages: [{ role: "user", content: "hi" }],
})
await new Promise((resolve) => setTimeout(resolve, 30))
const spans = exporter.getFinishedSpans().map((span) => ({
  name: span.name,
  attributes: span.attributes,
}))
await sdk.shutdown()
await new Promise<void>((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()))
})
if (spans.length === 0) {
  console.error(JSON.stringify({ ok: false, spans }, null, 2))
  process.exit(1)
}
const genAi = spans.filter(
  (span) =>
    span.name.toLowerCase().includes("chat") ||
    Object.keys(span.attributes).some((key) => key.startsWith("gen_ai")),
)
if (genAi.length === 0) {
  console.error(JSON.stringify({ ok: false, spans }, null, 2))
  process.exit(1)
}
const payload = { ok: true, genAi }
console.log(JSON.stringify(payload, null, 2))
