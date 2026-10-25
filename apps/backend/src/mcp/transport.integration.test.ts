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
import { recordSpans } from "../../test/spans.js"
import type { AppEnv } from "../app/env.js"
import { withNetworkOrgContext } from "../auth/withAuth.js"
import { closeDb, withOrgDbContext } from "../db/client.js"
import { workspaces } from "../db/schema/workspaces.js"
import { generateObjectId } from "../lib/id.js"
import { applyAttribution } from "../observability/attribution.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { registerMcpTools } from "./tools.js"
import { handleMcpTransportRequest } from "./transport.js"

const spans = recordSpans()

describeWithDatabase("MCP OAuth client actor", () => {
  let seed: SeededOrg
  const workspaceId = generateObjectId("ws")

  beforeAll(async () => {
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
    seed = await seedOrg()
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId: seed.orgId,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: `/tmp/mcp-oauth-${seed.orgId}`,
        desiredDefaultBranch: "main",
        writeStatus: "read_only",
      }),
    )
  })

  afterAll(async () => {
    if (seed) {
      await withOrgDbContext(seed.orgId, async (db) => {
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      })
      await cleanupSeededOrg(seed)
    }
    await closeDb()
  })

  it("keeps oauth_client after a shipped read tool runs", async () => {
    const orgId = seed.orgId
    const userId = seed.userId

    const events: Record<string, unknown>[] = []
    // An argument value must not reach a span or the request log.
    const secret = "secret-workspace-should-not-leak"
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use(
      evlog({
        drain: async (ctx) => {
          const batch = Array.isArray(ctx) ? ctx : [ctx]
          for (const item of batch) {
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
      c.set("user", { id: userId } as AppEnv["Variables"]["user"])
      c.set("session", {
        id: "sess_oauth",
      } as AppEnv["Variables"]["session"])
      c.set("oauthReferenceId", orgId)
      c.set("oauthClientId", "client_oauth")
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", seed.orgSlug)
      c.set("orgId", orgId)
      applyAttribution({
        "ctxpipe.actor.type": "oauth_client",
        "ctxpipe.org.id": orgId,
        "ctxpipe.org.slug": seed.orgSlug,
        "enduser.id": userId,
        "ctxpipe.oauth.client_id": "client_oauth",
      })
      await next()
    })
    app.use("*", withNetworkOrgContext)
    app.post("/mcp", (c) => handleMcpTransportRequest(c, registerMcpTools))

    const response = await app.request("http://backend.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-request-id": "req_mcp_oauth",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_workspaces",
          arguments: { org: seed.orgSlug, workspace: secret },
          _meta: { "ai.ctxpipe/turnId": "turn-1" },
        },
      }),
    })

    const result = mcpToolResult(await response.text())
    // The Workspace does not exist, so the result is a tool error.
    expect(result.isError).toBe(true)

    const serverSpan = spans.spanNamed("POST /mcp")
    expect(serverSpan?.attributes).toMatchObject({
      "ctxpipe.actor.type": "oauth_client",
      "ctxpipe.oauth.client_id": "client_oauth",
      "ctxpipe.mcp.tool": "list_workspaces",
      "enduser.id": userId,
      "request.id": "req_mcp_oauth",
    })
    const toolSpan = spans.spanNamed("mcp.tool list_workspaces")
    expect(toolSpan?.attributes).toMatchObject({
      "ctxpipe.mcp.turn.id": "turn-1",
      "ctxpipe.mcp.turn.source": "meta",
      "ctxpipe.mcp.correlation.source": "derived",
      "ctxpipe.mcp.connection.key": expect.stringMatching(/^mck_/),
    })
    expect(result._meta?.["ai.ctxpipe/callId"]).toBe(
      toolSpan?.attributes["ctxpipe.mcp.call.id"],
    )
    const actorSpans = spans
      .finishedSpans()
      .filter((span) => span.attributes["ctxpipe.actor.type"] != null)
    expect(actorSpans.length).toBeGreaterThan(0)
    for (const span of actorSpans) {
      expect(span.attributes["ctxpipe.actor.type"]).toBe("oauth_client")
    }
    const requestLog = events.find(
      (event) => event["ctxpipe.mcp.tool"] === "list_workspaces",
    )
    expect(requestLog).toMatchObject({
      "ctxpipe.actor.type": "oauth_client",
      "enduser.id": userId,
    })
    expect(
      JSON.stringify({
        spans: spans.finishedSpans().map((span) => span.attributes),
        log: requestLog,
      }),
    ).not.toContain(secret)
  }, 30_000)
})

function mcpToolResult(body: string): {
  isError?: boolean
  content?: Array<{ type?: string; text?: string }>
  _meta?: Record<string, unknown>
} {
  const payloads: unknown[] = []
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) {
    payloads.push(JSON.parse(trimmed))
  } else {
    for (const line of body.split("\n")) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : ""
      if (!data.startsWith("{")) continue
      payloads.push(JSON.parse(data))
    }
  }
  for (const payload of payloads) {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("result" in payload) ||
      typeof payload.result !== "object" ||
      payload.result === null
    ) {
      continue
    }
    return payload.result as ReturnType<typeof mcpToolResult>
  }
  throw new Error("MCP response did not include a tool result")
}
