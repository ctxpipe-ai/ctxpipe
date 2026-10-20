import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type {
  Implementation,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js"

/** `DiscoverResult` of the 2026-07-28 revision (`server/discover`). */
type ServerDiscoverResult = {
  resultType: "complete"
  supportedVersions: string[]
  capabilities: ServerCapabilities
  _meta: { "io.modelcontextprotocol/serverInfo": Implementation }
  instructions?: string
}

/**
 * The discover result for a server with its tools registered. The SDK keeps
 * `getCapabilities` private; `initialize` uses the same value, and the
 * framework integration test fails when the two differ.
 * `supportedVersions` lists only the versions that the transport serves, so a
 * 2026-07-28 client falls back to `initialize`.
 */
export function serverDiscoverResult(
  server: McpServer,
  input: {
    implementation: Implementation
    supportedVersions: readonly string[]
    instructions: string | undefined
  },
): ServerDiscoverResult {
  const capabilities = (
    server.server as unknown as { getCapabilities(): ServerCapabilities }
  ).getCapabilities()
  return {
    resultType: "complete",
    supportedVersions: [...input.supportedVersions],
    capabilities,
    _meta: { "io.modelcontextprotocol/serverInfo": input.implementation },
    ...(input.instructions ? { instructions: input.instructions } : {}),
  }
}

function isDiscoverRequest(
  message: unknown,
): message is { id: string | number } {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    message.method === "server/discover" &&
    "id" in message &&
    (typeof message.id === "string" || typeof message.id === "number")
  )
}

/**
 * The JSON-RPC response when the body holds only `server/discover`
 * requests, else null (the SDK transport handles the body).
 */
export function serverDiscoverResponse(
  body: unknown,
  result: () => ServerDiscoverResult,
): unknown {
  const messages = Array.isArray(body) ? body : [body]
  if (messages.length === 0 || !messages.every(isDiscoverRequest)) return null
  const responses = messages.map((message) => ({
    jsonrpc: "2.0" as const,
    id: message.id,
    result: result(),
  }))
  return Array.isArray(body) ? responses : responses[0]
}
