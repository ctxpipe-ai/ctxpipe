import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type {
  Implementation,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

const ServerDiscoverRequestSchema = z.object({
  method: z.literal("server/discover"),
  params: z.optional(z.looseObject({})),
})

/**
 * `server/discover` of the stateless MCP revision (2026-07-28): a client
 * reads the server info, capabilities, and instructions with no
 * `initialize`. The SDK has no handler for it yet.
 */
export function registerServerDiscover(
  server: McpServer,
  input: {
    implementation: Implementation
    supportedVersions: readonly string[]
    instructions: string | undefined
  },
): void {
  server.server.setRequestHandler(ServerDiscoverRequestSchema, async () => ({
    supportedVersions: [...input.supportedVersions],
    // Read at request time, after the tools register their capability.
    // The SDK keeps this method private; `initialize` uses the same value.
    capabilities: (
      server.server as unknown as { getCapabilities(): ServerCapabilities }
    ).getCapabilities(),
    serverInfo: input.implementation,
    ...(input.instructions ? { instructions: input.instructions } : {}),
  }))
}
