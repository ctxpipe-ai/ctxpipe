import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  cleanupSeededOrg,
  describeWithDatabase,
  type SeededOrg,
  seedOrg,
} from "../../test/db.js"
import type { AppEnv } from "../app/env.js"
import { getSystemDb } from "../db/client.js"
import { orgOnboarding } from "../db/schema/org_onboarding.js"
import { handleMcpTransportRequest } from "./transport.js"

function registerEchoTool(server: McpServer) {
  server.registerTool("echo", { description: "Echo" }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }))
}

describeWithDatabase("first MCP call", () => {
  let seed: SeededOrg

  beforeAll(async () => {
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
    seed = await seedOrg()
  })

  afterAll(async () => {
    await cleanupSeededOrg(seed)
  })

  function mcpApp(actor: "agent" | "web") {
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use(evlog())
    app.use("*", async (c, next) => {
      c.set("env", {
        AUTH_BASE_URL: "https://localhost:3000",
      } as AppEnv["Variables"]["env"])
      c.set("user", null)
      c.set("session", null)
      c.set("oauthOrganizationId", null)
      c.set("oauthClientId", null)
      c.set("personalApiKeyId", null)
      c.set(
        "orgApiKey",
        actor === "agent"
          ? { id: "key_test", orgId: seed.orgId, configId: "organization" }
          : null,
      )
      c.set("orgSlug", seed.orgSlug)
      c.set("orgId", seed.orgId)
      await next()
    })
    app.post("/mcp", (c) => handleMcpTransportRequest(c, registerEchoTool))
    return app
  }

  async function send(actor: "agent" | "web", message: object) {
    const response = await mcpApp(actor).request("http://backend.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
    })
    await response.text()
    expect(response.status).toBeLessThan(400)
  }

  const initialize = (name: string) => ({
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name, version: "1.0.0" },
    },
  })

  async function row() {
    const [found] = await getSystemDb()
      .select()
      .from(orgOnboarding)
      .where(eq(orgOnboarding.organizationId, seed.orgId))
    return found
  }

  it("ignores web sessions, then keeps the first agent's client and tool", async () => {
    await send("web", initialize("browser"))
    expect(await row()).toBeUndefined()

    await send("agent", initialize("claude-code"))
    const afterInit = await row()
    expect(afterInit?.firstMcpCallAt).toBeInstanceOf(Date)
    expect(afterInit?.firstMcpClient).toBe("claude-code")
    expect(afterInit?.firstMcpTool).toBeNull()

    await send("agent", initialize("cursor"))
    await send("agent", {
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    })
    const afterCall = await row()
    expect(afterCall?.firstMcpClient).toBe("claude-code")
    expect(afterCall?.firstMcpTool).toBe("echo")
    expect(afterCall?.firstMcpCallAt).toEqual(afterInit?.firstMcpCallAt)
  })
})
