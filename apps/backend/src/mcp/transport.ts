import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { Context } from "hono"
import type { AppEnv } from "../app/env.js"
import { getLogger, log } from "../observability/logger.js"
import { getMcpServerImplementation } from "./mcp-server-info.js"

/**
 * Hosted `/mcp` is the vendor-neutral client surface (ADR-029). First-party
 * plugins cannot cover every agent and review tool, so this transport prefers
 * safe interoperability over a strict reading of optional Streamable HTTP
 * features. Authenticated GET must open a real SSE listener: several clients,
 * including CodeRabbit, treat 405 on that GET as a failed session.
 */
export const MCP_SSE_OPEN_COMMENT = ": connected\n\n"

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  )
}

export function rejectInvalidMcpOrigin(c: Context<AppEnv>): Response | null {
  const expected = new URL(c.get("env").AUTH_BASE_URL)
  const requestHost = c.req.header("host")
  if (isLoopbackHostname(expected.hostname) && requestHost) {
    try {
      const requestHostname = new URL(`${expected.protocol}//${requestHost}`)
        .hostname
      if (!isLoopbackHostname(requestHostname)) {
        return new Response(null, { status: 403 })
      }
    } catch {
      return new Response(null, { status: 403 })
    }
  }

  const originHeader = c.req.header("origin")
  if (!originHeader) return null
  try {
    const origin = new URL(originHeader)
    const configuredOrigins = (c.get("env").AUTH_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    const allowed =
      origin.origin === expected.origin ||
      configuredOrigins.includes(origin.origin) ||
      (isLoopbackHostname(expected.hostname) &&
        isLoopbackHostname(origin.hostname) &&
        origin.protocol === expected.protocol &&
        origin.port === expected.port)
    return allowed ? null : new Response(null, { status: 403 })
  } catch {
    return new Response(null, { status: 403 })
  }
}

type JsonRpcShape = {
  method?: unknown
  params?: unknown
}

function asMessages(parsedBody: unknown): unknown[] {
  return Array.isArray(parsedBody) ? parsedBody : [parsedBody]
}

function extractRpcMethods(parsedBody: unknown): string[] {
  return asMessages(parsedBody)
    .flatMap((message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("method" in message) ||
        typeof message.method !== "string"
      ) {
        return []
      }
      return [message.method.slice(0, 100)]
    })
    .slice(0, 20)
}

function extractClientInfo(
  parsedBody: unknown,
): { name: string; version: string } | null {
  for (const message of asMessages(parsedBody)) {
    if (typeof message !== "object" || message === null) continue
    const rpc = message as JsonRpcShape
    if (rpc.method !== "initialize") continue
    if (typeof rpc.params !== "object" || rpc.params === null) continue
    const clientInfo = (rpc.params as { clientInfo?: unknown }).clientInfo
    if (typeof clientInfo !== "object" || clientInfo === null) continue
    const name =
      "name" in clientInfo && typeof clientInfo.name === "string"
        ? clientInfo.name.slice(0, 100)
        : null
    if (!name) continue
    const version =
      "version" in clientInfo && typeof clientInfo.version === "string"
        ? clientInfo.version.slice(0, 40)
        : "unknown"
    return { name, version }
  }
  return null
}

function isSseResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? ""
  return contentType.toLowerCase().includes("text/event-stream")
}

function mcpAuthType(c: Context<AppEnv>): "bearer" | "api-key" | "cookie" {
  if (c.req.header("authorization")?.startsWith("Bearer ")) return "bearer"
  if (c.req.header("x-api-key")) return "api-key"
  return "cookie"
}

async function releaseMcpSession(server: McpServer): Promise<void> {
  try {
    // McpServer owns and closes its connected transport.
    await server.close()
  } catch {
    // Stream cancellation may already have closed the server.
  }
}

function attachSseLifecycle(
  body: ReadableStream<Uint8Array>,
  options: {
    prefix?: Uint8Array
    onSettled: (
      reason: "cancelled" | "completed" | "error",
      error?: unknown,
    ) => void
  },
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let settled = false
  const settle = (
    reason: "cancelled" | "completed" | "error",
    error?: unknown,
  ) => {
    if (settled) return
    settled = true
    options.onSettled(reason, error)
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.prefix && options.prefix.byteLength > 0) {
        controller.enqueue(options.prefix)
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          settle("completed")
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        settle("error", error)
        controller.error(error)
      }
    },
    async cancel(reason) {
      settle("cancelled")
      await reader.cancel(reason)
    },
  })
}

export async function handleMcpTransportRequest(
  c: Context<AppEnv>,
  registerTools: (server: McpServer) => void,
) {
  const startedAt = performance.now()
  let parsedBody: unknown
  if (c.req.method === "POST") {
    parsedBody = await c.req.raw
      .clone()
      .json()
      .catch(() => undefined)
  }
  const rpcMethods = extractRpcMethods(parsedBody)
  const clientInfo = extractClientInfo(parsedBody)
  const requestLog = getLogger()
  const authType = mcpAuthType(c)
  const protocolVersion = c.req.header("mcp-protocol-version") ?? null
  const baseMcpLog = {
    rpcMethods,
    protocolVersion,
    authType,
    orgSlug: c.get("orgSlug"),
    method: c.req.method,
    ...(clientInfo
      ? { clientName: clientInfo.name, clientVersion: clientInfo.version }
      : {}),
  }

  const logRequest = (
    response: Response,
    extras?: {
      stream?: "opened"
    },
  ) => {
    requestLog.set({
      step: "mcp.request",
      mcp: {
        ...baseMcpLog,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        ...extras,
      },
    })
    if (extras?.stream === "opened") {
      requestLog.info("MCP stream opened")
    } else {
      requestLog.info("MCP request completed")
    }
    return response
  }

  const server = new McpServer(
    getMcpServerImplementation(c.get("env").AUTH_BASE_URL),
  )
  registerTools(server)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    keepAliveMs: 15_000,
  })

  try {
    await server.connect(transport)
    const res = await transport.handleRequest(c.req.raw, {
      parsedBody: c.req.method === "POST" ? parsedBody : undefined,
    })

    if (!isSseResponse(res) || !res.body) {
      await releaseMcpSession(server)
      return logRequest(res ?? new Response(null, { status: 204 }))
    }

    const encoder = new TextEncoder()
    const wrapped = attachSseLifecycle(res.body, {
      prefix:
        c.req.method === "GET"
          ? encoder.encode(MCP_SSE_OPEN_COMMENT)
          : undefined,
      onSettled: (closeReason, streamError) => {
        // Hono's request logger is emitted when the streaming Response returns.
        // The close event happens later, so emit it directly instead of writing
        // to the already-sealed request-wide event.
        const fields = {
          step: "mcp.request",
          message: "MCP stream closed",
          mcp: {
            ...baseMcpLog,
            status: res.status,
            durationMs: Math.round(performance.now() - startedAt),
            stream: "closed",
            closeReason,
          },
        }
        if (closeReason === "error") {
          log.error({
            ...fields,
            error:
              streamError instanceof Error
                ? streamError.message
                : String(streamError ?? "MCP response stream failed"),
          })
        } else {
          log.info(fields)
        }
        void releaseMcpSession(server)
      },
    })
    logRequest(res, { stream: "opened" })
    return new Response(wrapped, { status: res.status, headers: res.headers })
  } catch (error) {
    requestLog.set({
      step: "mcp.request",
      mcp: {
        ...baseMcpLog,
        durationMs: Math.round(performance.now() - startedAt),
      },
    })
    requestLog.error(
      error instanceof Error ? error : new Error("MCP request failed"),
    )
    await releaseMcpSession(server)
    throw error
  }
}
