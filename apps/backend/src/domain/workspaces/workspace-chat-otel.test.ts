import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { chat } from "@tanstack/ai"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import { AttributionUrlSpanProcessor } from "../../observability/otel.js"
import {
  beginWorkspaceChatProxyGeneration,
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
  iterateInWorkspaceChatTurn,
  markWorkspaceChatFirstShownToken,
  recordWorkspaceChatProxyGeneration,
  workspaceChatOtelMiddleware,
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
    // The socket has no auth attribution: the owner names the sender.
    const turnContext = beginWorkspaceChatTurn("conv_trace", "run_trace", {
      orgId: "org_1",
      orgSlug: "acme",
      workspaceId: "ws_1",
      userId: "user_1",
      source: "ui",
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
      "ctxpipe.actor.type": "user",
      "langfuse.trace.name": "workspace-chat",
      "session.id": "conv_trace",
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
        expect.arrayContaining(["org:acme", "ui"]),
      )
      expect(span?.attributes["langfuse.trace.metadata.orgId"], name).toBe(
        "org_1",
      )
      expect(span?.attributes["user.id"], name).toBe("user_1")
      // The collector sends only gen_ai spans to Langfuse, so each one
      // carries the trace name.
      expect(span?.attributes["langfuse.trace.name"], name).toBe(
        "workspace-chat",
      )
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

  it("gives a failed turn error status and a finished turn none", () => {
    beginWorkspaceChatTurn("conv_status", "run_failed")
    finishWorkspaceChatTurn("run_failed", { error: "sandbox start failed" })
    beginWorkspaceChatTurn("conv_status", "run_ok")
    finishWorkspaceChatTurn("run_ok")
    const statuses = exporter
      .getFinishedSpans()
      .map((span) => [
        span.attributes["workspace_chat.turn_id"],
        span.status.code,
      ])
    expect(statuses).toEqual([
      ["run_failed", SpanStatusCode.ERROR],
      ["run_ok", SpanStatusCode.UNSET],
    ])
  })

  it("keeps the newest whole messages and valid JSON when the prompt is too long", () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: "user",
      content: `message ${index} ${"x".repeat(1024)}`,
    }))
    beginWorkspaceChatTurn("conv_long", "run_long")
    beginWorkspaceChatProxyGeneration("run_long", { messages })
    recordWorkspaceChatProxyGeneration("run_long", {
      ttfbMs: 1,
      durationMs: 1,
      finishReason: "stop",
      tools: [],
      text: `answer ${"y".repeat(100 * 1024)} end`,
    })
    finishWorkspaceChatTurn("run_long")
    const generation = exporter
      .getFinishedSpans()
      .find(
        (span) =>
          span.attributes["workspace_chat.turn_id"] === "run_long" &&
          span.name.startsWith("generation"),
      )
    const input = String(generation?.attributes["langfuse.observation.input"])
    const output = String(generation?.attributes["langfuse.observation.output"])
    expect(input.length).toBeLessThanOrEqual(64 * 1024)
    expect(output.length).toBeLessThanOrEqual(64 * 1024)
    const kept = JSON.parse(input) as typeof messages
    expect(kept.at(-1)).toEqual(messages.at(-1))
    expect(kept[0]).not.toEqual(messages[0])
    expect(messages.slice(-kept.length)).toEqual(kept)
    expect(JSON.parse(output).role).toBe("assistant")
  })

  it("makes the TanStack turn summary and iteration plain Langfuse spans", async () => {
    class OneAnswer extends BaseTextAdapter<string, never, [], never> {
      readonly name = "one-answer"
      constructor() {
        super({}, "scripted/model")
      }
      async *chatStream(options: { runId?: string; threadId?: string }) {
        const run = { runId: options.runId, threadId: options.threadId }
        const timestamp = Date.now()
        yield { type: "RUN_STARTED", ...run, timestamp } as never
        yield {
          type: "RUN_FINISHED",
          ...run,
          finishReason: "stop",
          usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
          timestamp,
        } as never
      }
      async structuredOutput(): Promise<never> {
        throw new Error("Not used")
      }
    }
    for await (const _ of chat({
      adapter: new OneAnswer(),
      threadId: "thread",
      runId: "run_summary",
      messages: [{ role: "user", content: "hi" }],
      middleware: [workspaceChatOtelMiddleware()],
    }) as AsyncIterable<unknown>) {
      /* drain */
    }
    const tanstack = exporter
      .getFinishedSpans()
      .filter((span) => span.name.startsWith("chat scripted/model"))
    expect(tanstack.length).toBeGreaterThanOrEqual(2)
    for (const span of tanstack)
      expect(span.attributes["langfuse.observation.type"], span.name).toBe(
        "span",
      )
  })
})
