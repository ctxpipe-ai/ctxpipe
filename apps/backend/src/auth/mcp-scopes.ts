import type {
  McpServer,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Context } from "hono"

import type { AppEnv } from "../app/env.js"

export const MCP_READ_SCOPE = "ctxpipe:read"
export const MCP_WRITE_SCOPE = "ctxpipe:write"
type McpScope = typeof MCP_READ_SCOPE | typeof MCP_WRITE_SCOPE

/**
 * Scopes that `/mcp` advertises in its protected resource metadata. No MCP
 * tool writes yet, so ctxpipe offers only `ctxpipe:read`. A stored grant from
 * before can still list `ctxpipe:write`; nothing reads that as write.
 */
export const MCP_SCOPES: readonly McpScope[] = [MCP_READ_SCOPE]

/** MCP scopes of each request principal. Every principal gets read only. */
export const GRANTED_MCP_SCOPES: readonly McpScope[] = [MCP_READ_SCOPE]

/**
 * A tool with `readOnlyHint: true` needs `ctxpipe:read`. Each other tool
 * needs `ctxpipe:write`, so a tool without annotations fails closed.
 */
function requiredMcpScope(tool: Pick<RegisteredTool, "annotations">): McpScope {
  return tool.annotations?.readOnlyHint === true
    ? MCP_READ_SCOPE
    : MCP_WRITE_SCOPE
}

function registeredTools(server: McpServer): Record<string, RegisteredTool> {
  // The SDK keeps registered tools in a private field and gives no public
  // read access. `mcp.scopes.integration.test.ts` fails if the field moves.
  return (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools
}

/**
 * Disable each tool that the granted scopes do not cover. The SDK leaves a
 * disabled tool out of `tools/list` and refuses a call to it. Call this
 * before `server.connect`. Returns the names of the disabled tools with the
 * scope that each one needs.
 */
export function disableToolsOutsideScopes(
  server: McpServer,
  granted: readonly McpScope[],
): Map<string, McpScope> {
  const hidden = new Map<string, McpScope>()
  for (const [name, tool] of Object.entries(registeredTools(server))) {
    const required = requiredMcpScope(tool)
    if (granted.includes(required)) continue
    tool.disable()
    hidden.set(name, required)
  }
  return hidden
}

/** Escape a value for a quoted `WWW-Authenticate` parameter (RFC 7235). */
export function quoteHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * RFC 6750 §3.1 `insufficient_scope` response. The `scope` value names the
 * full set the client must request (granted plus missing), because MCP hosts
 * replace the grant with the scopes of the new authorization.
 */
export function insufficientMcpScopeResponse(
  c: Context<AppEnv>,
  input: {
    granted: readonly McpScope[]
    required: McpScope
    tool: string
    resourceMetadataUrl: string
  },
): Response {
  const needed = [...input.granted, input.required].join(" ")
  const description = `The tool ${input.tool} needs the ${input.required} scope`
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: `${description}. Reconnect and allow it.`,
      },
      id: null,
    },
    403,
    {
      "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${needed}", resource_metadata="${quoteHeaderValue(input.resourceMetadataUrl)}", error_description="${quoteHeaderValue(description)}"`,
    },
  )
}
