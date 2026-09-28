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
import { getSystemDb, initDb } from "../db/client.js"
import { users } from "../db/schema/auth.js"
import { userOnboardingRoutes } from "../routes/v1/onboarding.js"
import { handleMcpTransportRequest } from "./transport.js"

function registerEchoTool(server: McpServer) {
  server.registerTool("echo", { description: "Echo" }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }))
}

type Actor = "oauth-agent" | "org-api-key" | "web-session"

describeWithDatabase("first MCP call", () => {
  let admin: SeededOrg
  let joiner: SeededOrg

  beforeAll(async () => {
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
    admin = await seedOrg()
    joiner = await seedOrg()
  })

  afterAll(async () => {
    await cleanupSeededOrg(joiner)
    // cleanupSeededOrg closes the pool; reopen it for the second seed.
    initDb(process.env.DATABASE_URL ?? "")
    await cleanupSeededOrg(admin)
  })

  function withActor(app: Hono<AppEnv>, actor: Actor, seed: SeededOrg) {
    app.use(contextStorage())
    app.use(evlog())
    app.use("*", async (c, next) => {
      c.set("env", {
        AUTH_BASE_URL: "https://localhost:3000",
      } as AppEnv["Variables"]["env"])
      c.set(
        "user",
        actor === "org-api-key"
          ? null
          : ({ id: seed.userId } as AppEnv["Variables"]["user"]),
      )
      c.set("session", null)
      c.set("oauthOrganizationId", null)
      c.set("oauthClientId", actor === "oauth-agent" ? "client_test" : null)
      c.set("personalApiKeyId", null)
      c.set(
        "orgApiKey",
        actor === "org-api-key"
          ? { id: "key_test", orgId: seed.orgId, configId: "organization" }
          : null,
      )
      c.set("orgSlug", seed.orgSlug)
      c.set("orgId", seed.orgId)
      await next()
    })
    return app
  }

  async function send(actor: Actor, message: object, seed = admin) {
    const app = withActor(new Hono<AppEnv>(), actor, seed)
    app.post("/mcp", (c) => handleMcpTransportRequest(c, registerEchoTool))
    const response = await app.request("http://backend.test/mcp", {
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

  async function firstCall(seed: SeededOrg) {
    const app = withActor(new Hono<AppEnv>(), "web-session", seed)
    app.route("/onboarding", userOnboardingRoutes)
    const response = await app.request("http://backend.test/onboarding/user")
    expect(response.status).toBe(200)
    return ((await response.json()) as { firstMcpCall: unknown }).firstMcpCall
  }

  it("records only the user's own agent and keeps its first client and tool", async () => {
    await send("web-session", initialize("browser"))
    await send("org-api-key", initialize("ci-bot"))
    expect(await firstCall(admin)).toBeNull()

    await send("oauth-agent", initialize("claude-code"))
    const [afterInit] = await getSystemDb()
      .select({ at: users.firstMcpCallAt })
      .from(users)
      .where(eq(users.id, admin.userId))
    expect(await firstCall(admin)).toMatchObject({
      client: "claude-code",
      tool: null,
    })

    await send("oauth-agent", initialize("cursor"))
    await send("oauth-agent", {
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    })
    expect(await firstCall(admin)).toEqual({
      at: afterInit?.at?.toISOString(),
      client: "claude-code",
      tool: "echo",
    })

    // A joiner's agent step waits for their own agent, not the admin's.
    expect(await firstCall(joiner)).toBeNull()
  })
})
