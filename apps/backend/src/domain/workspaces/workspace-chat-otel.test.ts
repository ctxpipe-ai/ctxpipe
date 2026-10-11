import { context, SpanKind, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { contextWithAttributionBag } from "../../observability/attribution.js"
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import { AttributionUrlSpanProcessor } from "../../observability/otel.js"
import {
  beginWorkspaceChatProxyGeneration,
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
  iterateInWorkspaceChatTurn,
  markWorkspaceChatFirstShownToken,
  recordWorkspaceChatProxyGeneration,
} from "./workspace-chat-otel.js"

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    new AttributionUrlSpanProcessor(),
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

function proxyRequest(fn: () => void): string {
  const span = trace
    .getTracer("test")
    .startSpan("POST /v1/chat/completions", { kind: SpanKind.SERVER })
  context.with(trace.setSpan(context.active(), span), fn)
  span.end()
  return span.spanContext().spanId
}

describe("workspace chat turn trace", () => {
  it("joins the generations, the tools, and the TanStack chat span under one attributed turn root", async () => {
    const { context: socketContext, bag } = contextWithAttributionBag(
      context.active(),
    )
    bag.set("enduser.id", "user_1")
    bag.set("ctxpipe.actor.type", "user")
    let turnContext = context.active()
    context.with(socketContext, () => {
      turnContext = beginWorkspaceChatTurn("conv_trace", "run_trace", {
        orgId: "org_1",
        orgSlug: "acme",
        workspaceId: "ws_1",
      })
    })
    async function* chatBody() {
      trace.getTracer("tanstack").startSpan("chat test-model").end()
      yield 1
    }
    for await (const _ of iterateInWorkspaceChatTurn(turnContext, chatBody())) {
      /* drain */
    }
    const firstProxy = proxyRequest(() => {
      beginWorkspaceChatProxyGeneration("run_trace")
      recordWorkspaceChatProxyGeneration("run_trace", {
        ttfbMs: 10,
        durationMs: 20,
        finishReason: "tool_calls",
        tools: ["read"],
      })
    })
    proxyRequest(() => {
      beginWorkspaceChatProxyGeneration("run_trace")
      recordWorkspaceChatProxyGeneration("run_trace", {
        ttfbMs: 10,
        durationMs: 20,
        finishReason: "stop",
        tools: [],
      })
    })
    finishWorkspaceChatTurn("run_trace")

    const spans = exporter.getFinishedSpans()
    const byName = (name: string) => spans.find((span) => span.name === name)
    const root = byName("workspace-chat.turn")
    expect(root).toBeDefined()
    expect(root?.parentSpanContext).toBeUndefined()
    expect(root?.attributes).toMatchObject({
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
      "ctxpipe.workspace.id": "ws_1",
      "ctxpipe.conversation.id": "conv_trace",
      "enduser.id": "user_1",
      "langfuse.trace.name": "workspace-chat",
    })
    const traceId = root?.spanContext().traceId
    const rootId = root?.spanContext().spanId
    for (const name of [
      "generation #0",
      "generation #1",
      "tool read",
      "chat test-model",
    ]) {
      const span = byName(name)
      expect(span, name).toBeDefined()
      expect(span?.spanContext().traceId, name).toBe(traceId)
      expect(span?.parentSpanContext?.spanId, name).toBe(rootId)
      expect(span?.attributes["ctxpipe.org.id"], name).toBe("org_1")
      expect(span?.attributes["langfuse.trace.tags"], name).toEqual(
        expect.arrayContaining(["org:acme"]),
      )
      expect(span?.attributes["langfuse.trace.metadata.orgId"], name).toBe(
        "org_1",
      )
      expect(span?.attributes["user.id"], name).toBe("user_1")
    }
    expect(
      byName("generation #0")?.links.map((link) => link.context.spanId),
    ).toEqual([firstProxy])
  })
})

describe("workspace chat otel turn summary", () => {
  it("records generation loops and the tool gap before the next completion", () => {
    beginWorkspaceChatTurn("conv_otel", "run_otel")
    recordWorkspaceChatProxyGeneration("run_otel", {
      ttfbMs: 80,
      durationMs: 200,
      finishReason: "tool_calls",
      tools: ["bash"],
    })
    beginWorkspaceChatProxyGeneration("run_otel")
    recordWorkspaceChatProxyGeneration("run_otel", {
      ttfbMs: 40,
      durationMs: 90,
      finishReason: "stop",
      tools: [],
      text: "This repo is a TypeScript monorepo.",
    })
    markWorkspaceChatFirstShownToken("run_otel")
    const summary = finishWorkspaceChatTurn("run_otel")
    expect(summary?.loops).toBe(2)
    expect(summary?.generations.map((item) => item.finishReason)).toEqual([
      "tool_calls",
      "stop",
    ])
    expect(summary?.generations.at(-1)?.text).toBe(
      "This repo is a TypeScript monorepo.",
    )
    expect(summary?.tools.map((item) => item.name)).toEqual(["bash"])
    expect(summary?.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it("keeps overlapping conversation turns on separate run ids", () => {
    beginWorkspaceChatTurn("conv_overlap", "run_a")
    beginWorkspaceChatTurn("conv_overlap", "run_b")
    recordWorkspaceChatProxyGeneration("run_a", {
      ttfbMs: 10,
      durationMs: 20,
      finishReason: "stop",
      tools: [],
      text: "response-from-run-a",
    })
    recordWorkspaceChatProxyGeneration("run_b", {
      ttfbMs: 11,
      durationMs: 21,
      finishReason: "stop",
      tools: [],
      text: "response-from-run-b",
    })
    const first = finishWorkspaceChatTurn("run_a")
    const second = finishWorkspaceChatTurn("run_b")
    expect(first?.generations.map((item) => item.text)).toEqual([
      "response-from-run-a",
    ])
    expect(second?.generations.map((item) => item.text)).toEqual([
      "response-from-run-b",
    ])
    expect(finishWorkspaceChatTurn("run_a")).toBeNull()
  })
})
