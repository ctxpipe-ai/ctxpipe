import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CallToolRequestSchema,
  ReadResourceRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js"
import type { Context } from "hono"
import type { AppEnv } from "../app/env.js"
import {
  disableToolsOutsideScopes,
  grantedMcpScopes,
  insufficientMcpScopeResponse,
} from "../auth/mcp-scopes.js"
import {
  isAllowedRequestOrigin,
  isLoopbackHostname,
} from "../auth/request-origin.js"
import { mcpOAuthProtectedResourceMetadataUrl } from "../auth/withAuth.js"
import {
  type AttributionInput,
  applyAttribution,
} from "../observability/attribution.js"
import { getLogger } from "../observability/logger.js"
import { INSTRUCTION_RULES } from "./framework/instructions.js"
import {
  serverDiscoverResponse,
  serverDiscoverResult,
} from "./framework/server-discover.js"
import { getMcpServerImplementation } from "./mcp-server-info.js"
import { workspaceFileResourceName } from "./resources/workspace-file.js"

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
  return isAllowedRequestOrigin(c.get("env"), originHeader)
    ? null
    : new Response(null, { status: 403 })
}

export type McpTransportOptions = {
  /**
   * Dynamic server instructions for the principal of the request. The
   * transport loads them only for `initialize` and `server/discover`.
   */
  instructions?: () => Promise<string>
}

export async function handleMcpTransportRequest(
  c: Context<AppEnv>,
  registerTools: (server: McpServer) => void,
  options: McpTransportOptions = {},
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

  // Streamable HTTP returns the Response before tools/call or resources/read
  // runs, so the server span and request log would otherwise close without
  // these fields.
  const callAttribution = attributionFromCall(messages)
  if (callAttribution) applyAttribution(callAttribution)

  let instructions: string | undefined
  if (
    options.instructions &&
    rpcMethods.some(
      (method) => method === "initialize" || method === "server/discover",
    )
  ) {
    try {
      instructions = await options.instructions()
    } catch (error) {
      // The handshake must not fail: send the fixed rules without the orgs.
      log.error(error instanceof Error ? error : new Error(String(error)), {
        step: "mcp.instructions",
      })
      instructions = INSTRUCTION_RULES
    }
  }
  const implementation = getMcpServerImplementation(c.get("env").AUTH_BASE_URL)
  const server = new McpServer(
    implementation,
    instructions ? { instructions } : undefined,
  )
  registerTools(server)
  const grantedScopes = grantedMcpScopes(c.get("oauthScopes"))
  const hiddenTools = disableToolsOutsideScopes(server, grantedScopes)
  for (const message of messages) {
    const call = CallToolRequestSchema.safeParse(message)
    if (!call.success) continue
    const tool = call.data.params.name
    const required = hiddenTools.get(tool)
    if (!required) continue
    return logResponse(
      insufficientMcpScopeResponse(c, {
        granted: grantedScopes,
        required,
        tool,
        resourceMetadataUrl: mcpOAuthProtectedResourceMetadataUrl(
          c.var.env.AUTH_BASE_URL,
        ),
      }),
    )
  }
  // `server/discover` (2026-07-28) comes with no `initialize` and with a
  // protocol version header that the SDK transport refuses, so answer it here.
  const discover = serverDiscoverResponse(parsedBody, () =>
    serverDiscoverResult(server, {
      implementation,
      supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
      instructions,
    }),
  )
  if (discover) return logResponse(c.json(discover))
  const transport = new StreamableHTTPTransport()
  try {
    await server.connect(transport)
    const res = await transport.handleRequest(c, parsedBody)
    const isNotificationOnly =
      messages.length > 0 &&
      messages.every(
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

function attributionFromCall(
  messages: readonly unknown[],
): AttributionInput | undefined {
  for (const message of messages) {
    const tool = CallToolRequestSchema.safeParse(message)
    if (tool.success) {
      return { "ctxpipe.mcp.tool": tool.data.params.name.slice(0, 100) }
    }
    const read = ReadResourceRequestSchema.safeParse(message)
    if (!read.success) continue
    // The name only, never the URI: it holds a path.
    const resource = workspaceFileResourceName(read.data.params.uri)
    if (resource) return { "ctxpipe.mcp.resource": resource }
  }
  return undefined
}
