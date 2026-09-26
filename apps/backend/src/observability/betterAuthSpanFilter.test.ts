import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { BetterAuthSpanFilter } from "./betterAuthSpanFilter.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new BetterAuthSpanFilter(new SimpleSpanProcessor(exporter))],
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

function names(spans: ReadableSpan[]): string[] {
  return spans.map((span) => span.name).sort()
}

describe("Better Auth span filter", () => {
  it("drops better-auth spans and keeps other scopes", async () => {
    const server = trace.getTracer("ctxpipe-backend")
    const auth = trace.getTracer("better-auth")

    await server.startActiveSpan(
      "GET /.auth/api/v1/auth/get-session",
      {
        kind: SpanKind.SERVER,
        attributes: { "url.path": "/.auth/get-session" },
      },
      async (span) => {
        await auth.startActiveSpan("GET /get-session", async (endpoint) => {
          auth.startSpan("hook after /get-session").end()
          endpoint.end()
        })
        span.end()
      },
    )

    expect(names(exporter.getFinishedSpans())).toEqual([
      "GET /.auth/api/v1/auth/get-session",
    ])
  })

  it("keeps a better-auth span that failed", () => {
    const auth = trace.getTracer("better-auth")
    const failed = auth.startSpan("db findOne sessions")
    failed.setStatus({ code: SpanStatusCode.ERROR, message: "adapter failed" })
    failed.end()
    auth.startSpan("GET /get-session").end()

    const finished = exporter.getFinishedSpans()
    expect(finished.map((span) => span.name)).toEqual(["db findOne sessions"])
    expect(finished[0]?.status.code).toBe(SpanStatusCode.ERROR)
  })
})
