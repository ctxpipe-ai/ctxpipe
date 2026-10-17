import { readFileSync } from "node:fs"
import { trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { initLogger } from "evlog"
import { afterAll, beforeAll, expect, it } from "vitest"
import { EvlogSpanExporter, LLM_CONTENT_KEY } from "./evlog-span-exporter.js"

const memory = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(memory)],
})
const events: Record<string, unknown>[] = []

beforeAll(() => {
  provider.register()
  initLogger({
    enabled: true,
    pretty: false,
    env: { service: "ctxpipe-backend-test" },
    drain: async (ctx) => {
      for (const item of Array.isArray(ctx) ? ctx : [ctx])
        events.push(item.event as Record<string, unknown>)
    },
  })
})

afterAll(async () => {
  initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
  await provider.shutdown()
})

it("logs a generation span without its prompt and output", async () => {
  trace
    .getTracer("test")
    .startSpan("generation #0", {
      attributes: {
        "gen_ai.request.model": "openai/gpt-5.6-terra",
        "gen_ai.usage.input_tokens": 12,
        "langfuse.observation.input": "SECRET_PROMPT",
        "langfuse.observation.output": "SECRET_OUTPUT",
        "gen_ai.prompt.0.content": "SECRET_PROMPT",
        "gen_ai.completion.0.content": "SECRET_OUTPUT",
      },
    })
    .end()
  new EvlogSpanExporter().export(memory.getFinishedSpans(), () => {})
  await new Promise((resolve) => setTimeout(resolve, 20))

  const line = events.find((event) => event.span === "generation #0")
  expect(line?.attributes).toEqual({
    "gen_ai.request.model": "openai/gpt-5.6-terra",
    "gen_ai.usage.input_tokens": 12,
  })
  expect(JSON.stringify(events)).not.toMatch(/SECRET_(PROMPT|OUTPUT)/)
})

it("uses the same key rule as the collector redaction", () => {
  const config = readFileSync(
    new URL(
      "../../../../ops/observability/collector/config.yaml",
      import.meta.url,
    ),
    "utf8",
  )
  const yamlPattern = LLM_CONTENT_KEY.source.replaceAll("\\", "\\\\")
  expect(config).toContain(
    `delete_matching_keys(span.attributes, "${yamlPattern}")`,
  )
})
