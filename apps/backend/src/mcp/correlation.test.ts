import {
  type McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { SpanStatusCode, trace } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { recordSpans } from "../../test/spans.js"
import type { AppEnv } from "../app/env.js"
import { toToon } from "../lib/agentToolRuntime.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { applyLogContract } from "../observability/logContract.js"
import {
  mcpOrgSlugHash,
  readMcpCorrelation,
  runBridgeToolCall,
  runMcpResourceRead,
  runMcpToolCall,
  setMcpOrgSlugHash,
} from "./correlation.js"
import { McpToolError } from "./framework/tool-errors.js"
import { toolFailure, toolSuccess } from "./framework/tool-result.js"
import { registerWorkspaceFileResource } from "./resources/workspace-file.js"
import { handleMcpTransportRequest } from "./transport.js"

const spans = recordSpans()

/** The wide events that evlog drained, one for each request. */
const events: Record<string, unknown>[] = []
beforeEach(() => {
  events.length = 0
})

const clientTraceId = "4bf92f3577b34da6a3ce929d0e0e4736"
const clientSpanId = "00f067aa0ba902b7"
const validTraceparent = `00-${clientTraceId}-${clientSpanId}-01`

const secretQuery = "QUERY_TEXT_MUST_NOT_LEAK how do we deploy"
const secretPath = "services/billing/SECRET_PATH.md"
const secretRepoUrl = "https://github.com/example-org/secret-repo.git"

type Principal = {
  userId?: string
  apiKeyId?: string
  oauthClientId?: string
}

beforeAll(() => {
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
  })
})

function buildApp(
  principal: Principal = { userId: "user_1" },
  tool: (args: Record<string, unknown>) => Promise<unknown> = async () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }),
  registerResources: (server: McpServer) => void = () => {},
) {
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(
    evlog({
      drain: async (ctx) => {
        for (const item of Array.isArray(ctx) ? ctx : [ctx]) {
          events.push(item.event as Record<string, unknown>)
        }
      },
    }),
  )
  app.use("*", backendOtelMiddleware())
  app.use("*", async (c, next) => {
    c.set("env", {
      AUTH_BASE_URL: "https://localhost:3000",
    } as AppEnv["Variables"]["env"])
    c.set(
      "user",
      principal.userId
        ? ({ id: principal.userId } as AppEnv["Variables"]["user"])
        : null,
    )
    c.set("session", null)
    c.set("oauthReferenceId", null)
    c.set("oauthClientId", principal.oauthClientId ?? null)
    c.set(
      "orgApiKey",
      principal.apiKeyId
        ? {
            id: principal.apiKeyId,
            orgId: "org_acme",
            configId: "organization",
          }
        : null,
    )
    c.set("orgSlug", "acme")
    c.set("orgId", "org_acme")
    await next()
  })
  app.post("/mcp", (c) =>
    handleMcpTransportRequest(c, (server) => {
      server.registerTool(
        "search_context",
        {
          annotations: { readOnlyHint: true },
          inputSchema: z.object({
            query: z.string(),
            path: z.string().optional(),
            repository: z.string().optional(),
          }),
        },
        async (args, extra) =>
          runMcpToolCall(
            { toolName: "search_context", extra },
            async () =>
              (await tool(args)) as {
                content: Array<{ type: "text"; text: string }>
              },
          ),
      )
      registerResources(server)
    }),
  )
  return app
}

async function callTool(
  app: Hono<AppEnv>,
  options: {
    meta?: Record<string, unknown>
    headers?: Record<string, string>
    args?: Record<string, unknown>
  } = {},
) {
  const response = await app.request("http://backend.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_context",
        arguments: options.args ?? { query: "hello" },
        ...(options.meta ? { _meta: options.meta } : {}),
      },
    }),
  })
  expect(response.status).toBe(200)
  const result = toolResult(await response.text())
  const span = spans.spanNamed("mcp.tool search_context")
  if (!span) throw new Error("no tool span")
  return { result, span }
}

describe("MCP call correlation", () => {
  it("puts client conversation and turn ids from _meta on the tool span and the call id on the result", async () => {
    const { result, span } = await callTool(buildApp(), {
      meta: {
        "ai.ctxpipe/conversationId": "conv-123",
        "ai.ctxpipe/turnId": "turn-7",
      },
    })

    expect(span.attributes).toMatchObject({
      "ctxpipe.mcp.tool": "search_context",
      "ctxpipe.mcp.conversation.id": "conv-123",
      "ctxpipe.mcp.conversation.source": "meta",
      "ctxpipe.mcp.turn.id": "turn-7",
      "ctxpipe.mcp.turn.source": "meta",
      "ctxpipe.mcp.correlation.source": "client",
    })
    const callId = span.attributes["ctxpipe.mcp.call.id"]
    expect(callId).toMatch(/^call_[a-z0-9]+$/)
    expect(result._meta?.["ai.ctxpipe/callId"]).toBe(callId)
  })

  it("marks the correlation as derived when the client sends no conversation id", async () => {
    const { result, span } = await callTool(buildApp())

    expect(span.attributes["ctxpipe.mcp.correlation.source"]).toBe("derived")
    expect(span.attributes["ctxpipe.mcp.conversation.id"]).toBeUndefined()
    expect(span.attributes["ctxpipe.mcp.turn.id"]).toBeUndefined()
    expect(span.attributes["ctxpipe.mcp.connection.key"]).toMatch(
      /^mck_[0-9a-f]{32}$/,
    )
    expect(result._meta?.["ai.ctxpipe/callId"]).toEqual(expect.any(String))
  })

  it("reads each id source and applies the precedence meta, header, baggage, openai, codex", async () => {
    const app = buildApp()
    const meta = {
      "ai.ctxpipe/conversationId": "conv-meta",
      "ai.ctxpipe/turnId": "turn-meta",
      baggage:
        "ai.ctxpipe.conversationId=conv-baggage,ai.ctxpipe.turnId=turn-baggage",
      "openai/session": "conv-openai",
    }
    const headers = {
      "x-ctxpipe-conversation-id": "conv-header",
      "x-ctxpipe-turn-id": "turn-header",
      "x-codex-turn-metadata": JSON.stringify({
        session_id: "conv-codex",
        turn_id: "turn-codex",
      }),
    }

    const cases: Array<{
      meta: Record<string, unknown>
      headers: Record<string, string>
      conversation: [string, string]
      turn: [string, string] | undefined
    }> = [
      {
        meta,
        headers,
        conversation: ["conv-meta", "meta"],
        turn: ["turn-meta", "meta"],
      },
      {
        meta: { baggage: meta.baggage, "openai/session": "conv-openai" },
        headers,
        conversation: ["conv-header", "header"],
        turn: ["turn-header", "header"],
      },
      {
        meta: { baggage: meta.baggage, "openai/session": "conv-openai" },
        headers: { "x-codex-turn-metadata": headers["x-codex-turn-metadata"] },
        conversation: ["conv-baggage", "baggage"],
        turn: ["turn-baggage", "baggage"],
      },
      {
        meta: { "openai/session": "conv-openai" },
        headers: { "x-codex-turn-metadata": headers["x-codex-turn-metadata"] },
        conversation: ["conv-openai", "openai"],
        turn: ["turn-codex", "codex"],
      },
      {
        meta: {},
        headers: { "x-codex-turn-metadata": headers["x-codex-turn-metadata"] },
        conversation: ["conv-codex", "codex"],
        turn: ["turn-codex", "codex"],
      },
    ]

    for (const item of cases) {
      const { span } = await callTool(app, {
        meta: item.meta,
        headers: item.headers,
      })
      expect(span.attributes).toMatchObject({
        "ctxpipe.mcp.conversation.id": item.conversation[0],
        "ctxpipe.mcp.conversation.source": item.conversation[1],
        "ctxpipe.mcp.correlation.source": "client",
      })
      expect(span.attributes["ctxpipe.mcp.turn.id"]).toBe(item.turn?.[0])
      expect(span.attributes["ctxpipe.mcp.turn.source"]).toBe(item.turn?.[1])
    }
  })

  it("ignores ids that are not short opaque tokens", () => {
    const correlation = readMcpCorrelation({
      meta: {
        "ai.ctxpipe/conversationId": "has spaces and a question?",
        "ai.ctxpipe/turnId": "x".repeat(129),
        "openai/session": "someone@example.com",
      },
      headers: {
        "x-ctxpipe-conversation-id": "",
        "x-ctxpipe-turn-id": "dev@example.com",
        "x-codex-turn-metadata": "{not json",
      },
    })
    expect(correlation.conversation).toBeUndefined()
    expect(correlation.turn).toBeUndefined()
  })

  it("links the client's W3C trace and keeps the server span as the parent", async () => {
    const { span } = await callTool(buildApp(), {
      meta: { traceparent: validTraceparent, tracestate: "vendor=abc" },
    })

    const server = spans.spanNamed("POST /mcp")
    expect(span.spanContext().traceId).toBe(server?.spanContext().traceId)
    expect(span.parentSpanContext?.spanId).toBe(server?.spanContext().spanId)
    const clientLink = span.links.find(
      (link) => link.context.traceId === clientTraceId,
    )
    expect(clientLink?.context.spanId).toBe(clientSpanId)
    // The client tracestate must not go out on our requests.
    expect(clientLink?.context.traceState).toBeUndefined()
  })

  it("records the call when the client traceparent is not sampled", async () => {
    const { span } = await callTool(buildApp(), {
      meta: { traceparent: `00-${clientTraceId}-${clientSpanId}-00` },
    })

    expect(span.attributes["ctxpipe.mcp.call.id"]).toEqual(expect.any(String))
    expect(
      span.links.some((link) => link.context.traceId === clientTraceId),
    ).toBe(true)
  })

  it("ignores a malformed traceparent and stays in the server trace", async () => {
    const app = buildApp()
    const malformed = [
      "garbage",
      `00-${"0".repeat(32)}-${clientSpanId}-01`,
      `00-${clientTraceId}-${"0".repeat(16)}-01`,
      `ff-${clientTraceId}-${clientSpanId}-01`,
      `00-${clientTraceId.toUpperCase()}-${clientSpanId}-01`,
      `00-${clientTraceId}-${clientSpanId}-01-extra`,
      42,
    ]
    for (const traceparent of malformed) {
      const { result, span } = await callTool(app, { meta: { traceparent } })
      const server = spans.spanNamed("POST /mcp")
      expect(result.isError).not.toBe(true)
      expect(span.spanContext().traceId).toBe(server?.spanContext().traceId)
      expect(
        span.links.some((link) => link.context.traceId === clientTraceId),
      ).toBe(false)
    }
  })

  it("keeps one connection key per client and principal", async () => {
    const userApp = buildApp({ userId: "user_1" })
    const first = await callTool(userApp, {
      meta: { "io.modelcontextprotocol/clientInfo": { name: "claude-code" } },
    })
    const second = await callTool(userApp, {
      meta: { "io.modelcontextprotocol/clientInfo": { name: "claude-code" } },
    })
    const otherClient = await callTool(userApp, {
      meta: { "io.modelcontextprotocol/clientInfo": { name: "cursor" } },
    })
    const otherUser = await callTool(buildApp({ userId: "user_2" }), {
      meta: { "io.modelcontextprotocol/clientInfo": { name: "claude-code" } },
    })
    const oauth = await callTool(
      buildApp({ userId: "user_1", oauthClientId: "client_a" }),
      { meta: { "io.modelcontextprotocol/clientInfo": { name: "cursor" } } },
    )
    const oauthOtherName = await callTool(
      buildApp({ userId: "user_1", oauthClientId: "client_a" }),
      { meta: { "io.modelcontextprotocol/clientInfo": { name: "renamed" } } },
    )
    const apiKey = await callTool(buildApp({ apiKeyId: "key_1" }), {
      headers: { "user-agent": "codex_cli_rs/0.50.0 (Mac OS)" },
    })

    const key = (span: ReadableSpan) =>
      span.attributes["ctxpipe.mcp.connection.key"]
    expect(key(first.span)).toBe(key(second.span))
    expect(key(otherClient.span)).not.toBe(key(first.span))
    expect(key(otherUser.span)).not.toBe(key(first.span))
    expect(key(oauth.span)).toBe(key(oauthOtherName.span))
    expect(key(oauth.span)).not.toBe(key(otherClient.span))
    expect(apiKey.span.attributes["ctxpipe.mcp.client.name"]).toBe(
      "codex_cli_rs",
    )
    for (const span of [first.span, apiKey.span]) {
      expect(String(key(span))).not.toContain("user_1")
      expect(String(key(span))).not.toContain("key_1")
    }
  })

  it("puts the hash of the org slug on the span, never the slug", async () => {
    const { span } = await callTool(
      buildApp({ userId: "user_1" }, async () => {
        setMcpOrgSlugHash("acme")
        return { content: [{ type: "text" as const, text: "ok" }] }
      }),
    )

    const hash = span.attributes["ctxpipe.mcp.org.slug_hash"]
    expect(hash).toBe(mcpOrgSlugHash("acme"))
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
    expect(hash).not.toBe(mcpOrgSlugHash("other"))
    expect(
      JSON.stringify(span.attributes["ctxpipe.mcp.org.slug_hash"]),
    ).not.toContain("acme")
  })

  it("puts no query text, paths or repository URLs on any span", async () => {
    await callTool(buildApp(), {
      args: { query: secretQuery, path: secretPath, repository: secretRepoUrl },
      meta: {
        "ai.ctxpipe/conversationId": "conv-1",
        traceparent: validTraceparent,
      },
    })

    const serialized = JSON.stringify(
      spans.finishedSpans().map((span) => span.attributes),
    )
    expect(serialized).not.toContain("QUERY_TEXT_MUST_NOT_LEAK")
    expect(serialized).not.toContain("SECRET_PATH")
    expect(serialized).not.toContain("secret-repo")
  })

  it("returns the call id on a failed call and marks the span as an error", async () => {
    const { result, span } = await callTool(
      buildApp({ userId: "user_1" }, async () => {
        throw new Error("Workspace not found")
      }),
    )

    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toBe("Workspace not found")
    expect(result._meta?.["ai.ctxpipe/callId"]).toBe(
      span.attributes["ctxpipe.mcp.call.id"],
    )
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
  })
})

describe("MCP tool result facts", () => {
  it("puts the error code of a tool that returns isError on the tool span and the wide event", async () => {
    const { result, span } = await callTool(
      buildApp({ userId: "user_1" }, async () =>
        toolFailure(new McpToolError("org_not_found", "No such org.")),
      ),
    )

    expect(result.isError).toBe(true)
    expect(span.attributes["ctxpipe.mcp.error.code"]).toBe("org_not_found")
    expect(events.at(-1)?.["ctxpipe.mcp.error.code"]).toBe("org_not_found")
    // A bad call is not a server fault: the span stays out of ERROR.
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR)
  })

  it("sets no error code on a result that is not an error", async () => {
    const { span } = await callTool(
      buildApp({ userId: "user_1" }, async () => toolSuccess({ items: [] })),
    )

    expect(span.attributes["ctxpipe.mcp.error.code"]).toBeUndefined()
    expect(events.at(-1)?.["ctxpipe.mcp.error.code"]).toBeUndefined()
  })

  it("records the size of the result in bytes on the tool span and the wide event", async () => {
    const { result, span } = await callTool(
      buildApp({ userId: "user_1" }, async () => ({
        content: [{ type: "text" as const, text: "x".repeat(2000) }],
      })),
    )

    const bytes = span.attributes["ctxpipe.mcp.result.bytes"]
    expect(bytes).toEqual(expect.any(Number))
    expect(bytes as number).toBeGreaterThan(2000)
    // The size is the size of the result that the client gets, call id included.
    expect(bytes).toBe(Buffer.byteLength(JSON.stringify(result)))
    expect(events.at(-1)?.["ctxpipe.mcp.result.bytes"]).toBe(bytes)
  })
})

describe("bridge tool call facts", () => {
  const span = () => spans.spanNamed("bridge.tool get_file")

  it("puts the tool name, a call id and the size of the result on the span", async () => {
    const result = await runBridgeToolCall("get_file", async () => "owner: a\n")

    expect(result).toBe("owner: a\n")
    expect(span()?.attributes).toMatchObject({
      "ctxpipe.mcp.tool": "get_file",
      "ctxpipe.mcp.call.id": expect.stringMatching(/^call_/),
      "ctxpipe.mcp.result.bytes": Buffer.byteLength("owner: a\n"),
    })
    expect(span()?.attributes["ctxpipe.mcp.error.code"]).toBeUndefined()
    expect(span()?.status.code).not.toBe(SpanStatusCode.ERROR)
  })

  it("puts the code of an error result on the span, and leaves the span out of ERROR", async () => {
    await runBridgeToolCall("get_file", async () =>
      toToon({ error: "checkout_not_in_run", repositoryId: "repo_1" }),
    )

    expect(span()?.attributes["ctxpipe.mcp.error.code"]).toBe(
      "checkout_not_in_run",
    )
    expect(span()?.status.code).not.toBe(SpanStatusCode.ERROR)
  })

  it("gives each call its own call id", async () => {
    await runBridgeToolCall("get_file", async () => "a")
    await runBridgeToolCall("get_file", async () => "b")

    const ids = spans
      .finishedSpans()
      .filter((item) => item.name === "bridge.tool get_file")
      .map((item) => item.attributes["ctxpipe.mcp.call.id"])
    expect(new Set(ids).size).toBe(2)
  })

  it("gives a child span and a log inside the call the tool name and the call id, and keeps two concurrent calls apart", async () => {
    const logs: Record<string, Record<string, unknown>> = {}
    const run = (tool: string, delayMs: number) =>
      runBridgeToolCall(tool, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        await trace
          .getTracer("test")
          .startActiveSpan(`child of ${tool}`, async (child) => {
            child.end()
          })
        const event: Record<string, unknown> = {}
        applyLogContract(event)
        logs[tool] = event
        return "ok"
      })

    await Promise.all([run("search_code", 20), run("get_file", 5)])

    for (const tool of ["search_code", "get_file"]) {
      const bridge = spans.spanNamed(`bridge.tool ${tool}`)
      const child = spans.spanNamed(`child of ${tool}`)
      const callId = bridge?.attributes["ctxpipe.mcp.call.id"]
      expect(callId).toEqual(expect.stringMatching(/^call_/))
      expect(child?.attributes).toMatchObject({
        "ctxpipe.mcp.tool": tool,
        "ctxpipe.mcp.call.id": callId,
      })
      expect(logs[tool]).toMatchObject({
        "ctxpipe.mcp.tool": tool,
        "ctxpipe.mcp.call.id": callId,
      })
    }
  })

  it("marks the span as an internal error and throws the error on", async () => {
    await expect(
      runBridgeToolCall("get_file", async () => {
        throw new Error("codesearch is down")
      }),
    ).rejects.toThrow("codesearch is down")

    expect(span()?.attributes["ctxpipe.mcp.error.code"]).toBe("internal")
    expect(span()?.status.code).toBe(SpanStatusCode.ERROR)
  })
})

describe("MCP resource read correlation", () => {
  async function readResource(app: Hono<AppEnv>, uri: string) {
    const response = await app.request("http://backend.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: {
          uri,
          _meta: { "ai.ctxpipe/conversationId": "conv-res" },
        },
      }),
    })
    expect(response.status).toBe(200)
    return rpcError(await response.text())
  }

  it("reads the workspace-file resource in an mcp.resource span and returns the call id on a user error", async () => {
    const app = buildApp({ userId: "user_1" }, undefined, (server) =>
      registerWorkspaceFileResource(server),
    )
    // A URI with a bad percent escape fails before any database read.
    const error = await readResource(
      app,
      "ctxpipe://acme/payments/knowledge/%E0%A4%A.md",
    )
    expect(error.data?.code).toBe("invalid_ref")

    const span = spans.spanNamed("mcp.resource workspace-file")
    if (!span) throw new Error("no resource span")
    expect(span.attributes).toMatchObject({
      "ctxpipe.mcp.resource": "workspace-file",
      "ctxpipe.mcp.conversation.id": "conv-res",
    })
    expect(span.attributes["ctxpipe.mcp.call.id"]).toMatch(/^call_[a-z0-9]+$/)
    expect(span.attributes["ctxpipe.mcp.tool"]).toBeUndefined()
    // The client gets the same id as the span, as for a failed tool call.
    expect(error.data?.["ai.ctxpipe/callId"]).toBe(
      span.attributes["ctxpipe.mcp.call.id"],
    )
    // The message keeps the text of the error, with no second SDK prefix.
    expect(error.message).toBe(
      "MCP error -32602: The ref in the URI is not valid.",
    )
    // A user error is not a server fault: the span stays out of ERROR.
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR)
    // The code of a thrown user error is on the span, as for a tool result.
    expect(span.attributes["ctxpipe.mcp.error.code"]).toBe("invalid_ref")
  })

  it("marks the span as an error only for an internal error, and still returns the call id", async () => {
    const app = buildApp({ userId: "user_1" }, undefined, (server) =>
      server.registerResource(
        "broken",
        new ResourceTemplate("broken://{name}", { list: undefined }),
        {},
        (_uri, _variables, extra) =>
          runMcpResourceRead({ resourceName: "broken", extra }, async () => {
            throw new McpError(ErrorCode.InternalError, "It broke.", {
              code: "internal",
              retryable: true,
            })
          }),
      ),
    )
    const error = await readResource(app, "broken://one")

    const span = spans.spanNamed("mcp.resource broken")
    if (!span) throw new Error("no resource span")
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(error.data?.["ai.ctxpipe/callId"]).toBe(
      span.attributes["ctxpipe.mcp.call.id"],
    )
    expect(error.data?.retryable).toBe(true)
  })
})

function rpcError(body: string): {
  code?: number
  message?: string
  data?: Record<string, unknown>
} {
  for (const line of body.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.trim()
    if (!data.startsWith("{")) continue
    const payload = JSON.parse(data) as { error?: unknown }
    if (payload.error && typeof payload.error === "object") {
      return payload.error as ReturnType<typeof rpcError>
    }
  }
  throw new Error(`MCP response did not include an error: ${body}`)
}

function toolResult(body: string): {
  isError?: boolean
  content?: Array<{ type?: string; text?: string }>
  _meta?: Record<string, unknown>
} {
  for (const line of body.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.trim()
    if (!data.startsWith("{")) continue
    const payload = JSON.parse(data) as { result?: unknown }
    if (payload.result && typeof payload.result === "object") {
      return payload.result as ReturnType<typeof toolResult>
    }
  }
  throw new Error(`MCP response did not include a tool result: ${body}`)
}
