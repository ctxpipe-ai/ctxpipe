import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"

import type { SeededOrg } from "../../test/db.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import type { McpReadTool } from "../mcp/framework/tool-registry.js"
import { registerMcpRoutes } from "../routes/mcp.js"
import { withTestRequestLogger } from "./hono-test-logger.js"

/** An MCP client over the real `/mcp` route with one tool registered. */
export async function connectToolClient(
  seed: Pick<SeededOrg, "orgApiKey">,
  tool: McpReadTool,
): Promise<Client> {
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use(evlog())
  app.use("*", async (c, next) => {
    c.set("env", parseEnv(process.env))
    c.set("user", null)
    c.set("session", null)
    c.set("oauthReferenceId", null)
    c.set("oauthClientId", null)
    c.set("orgApiKey", null)
    c.set("personalApiKeyId", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })
  registerMcpRoutes(app, { registerTools: (server) => tool.register(server) })
  const client = new Client({ name: "mcp-tool-client", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: { headers: { "x-api-key": seed.orgApiKey } },
    }),
  )
  await client.listTools()
  return client
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}
