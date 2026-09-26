import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { Context } from "hono"
import type { AppEnv } from "../app/env.js"
import { currentMcpActor, requireCurrentOrgId } from "../auth/context.js"
import {
  type AttributionInput,
  applyAttribution,
} from "../observability/attribution.js"
import { getLogger } from "../observability/logger.js"
import { mcpAdvisorThreadId } from "./advisorThread.js"
import { getMcpServerImplementation } from "./mcp-server-info.js"

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
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody]
  const rpcMethods = messages
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
  const log = getLogger()
  const authType = c.req.header("authorization")?.startsWith("Bearer ")
    ? "bearer"
    : c.req.header("x-api-key")
      ? "api-key"
      : "cookie"
  const logResponse = (response: Response) => {
    log.set({
      step: "mcp.request",
      mcp: {
        rpcMethods,
        protocolVersion: c.req.header("mcp-protocol-version") ?? null,
        authType,
        orgSlug: c.get("orgSlug"),
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      },
    })
    log.info("MCP request completed")
    return response
  }

  if (c.req.method === "GET") {
    return logResponse(
      new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } }),
    )
  }

  // Streamable HTTP returns the Response before tools/call runs, so the
  // server span and request log would otherwise close without these fields.
  // SSE stays on: clients send progress notifications and accept event-stream.
  const toolAttribution = attributionFromToolsCall(parsedBody)
  if (toolAttribution) applyAttribution(toolAttribution)

  const server = new McpServer(
    getMcpServerImplementation(c.get("env").AUTH_BASE_URL),
  )
  registerTools(server)
  const transport = new StreamableHTTPTransport()
  try {
    await server.connect(transport)
    const res = await transport.handleRequest(c, parsedBody)
    const parsedMessages = Array.isArray(parsedBody) ? parsedBody : [parsedBody]
    const isNotificationOnly =
      parsedMessages.length > 0 &&
      parsedMessages.every(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          !("id" in message),
      )
    if (isNotificationOnly && res?.status === 202) {
      const headers = new Headers(res.headers)
      headers.delete("content-type")
      return logResponse(new Response(null, { status: 202, headers }))
    }
    return logResponse(res ?? new Response(null, { status: 204 }))
  } catch (error) {
    log.set({
      step: "mcp.request",
      mcp: {
        rpcMethods,
        protocolVersion: c.req.header("mcp-protocol-version") ?? null,
        authType,
        orgSlug: c.get("orgSlug"),
        durationMs: Math.round(performance.now() - startedAt),
      },
    })
    log.error(error instanceof Error ? error : new Error("MCP request failed"))
    throw error
  }
}

function attributionFromToolsCall(
  parsedBody: unknown,
): AttributionInput | undefined {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody]
  for (const message of messages) {
    const parsed = CallToolRequestSchema.safeParse(message)
    if (!parsed.success) continue
    const name = parsed.data.params.name.trim().slice(0, 100)
    if (!name) continue
    const args = parsed.data.params.arguments ?? {}
    const rawConversationId = args.conversationId
    let conversationId: string | undefined
    if (name === "ctx_advisor" && typeof rawConversationId === "string") {
      const actor = currentMcpActor()
      conversationId = mcpAdvisorThreadId({
        orgId: requireCurrentOrgId(),
        actorKey: actor.type === "org-service" ? "org" : actor.userId,
        currentProjectName:
          typeof args.currentProjectName === "string"
            ? args.currentProjectName
            : undefined,
        conversationId: rawConversationId,
      })
    }
    return {
      "ctxpipe.mcp.tool": name,
      ...(conversationId ? { "ctxpipe.conversation.id": conversationId } : {}),
    }
  }
  return undefined
}
