import { trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace"
import { initLogger } from "evlog"
import { afterAll, beforeAll, expect, it } from "vitest"

import { registerTracerProvider } from "../../test/tracer.js"
import { EvlogSpanExporter } from "./evlog-span-exporter.js"

const memory = new InMemorySpanExporter()
const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter: memory })],
})
const events: Record<string, unknown>[] = []

beforeAll(() => {
  registerTracerProvider(provider)
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
        "gen_ai.input.messages": "SECRET_PROMPT",
        "gen_ai.output.messages": "SECRET_OUTPUT",
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
