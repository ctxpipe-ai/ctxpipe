import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  cleanupSeededOrg,
  describeWithDatabase,
  type SeededOrg,
  seedOrg,
} from "../../../test/db.js"
import { recordSpans } from "../../../test/spans.js"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { applyAttribution } from "../../observability/attribution.js"
import { backendOtelMiddleware } from "../../observability/http.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationFileRoutes } from "./conversation-files-routes.js"

const spans = recordSpans()

describeWithDatabase("conversation files/status HTTP attribution", () => {
  let seed: SeededOrg
  const workspaceId = generateObjectId("ws")
  const conversationId = generateObjectId("conv")

  beforeAll(async () => {
    seed = await seedOrg()
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId: seed.orgId,
        slug: `ws-${workspaceId.slice(-8)}`,
        displayName: "Files status attribution",
        workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${workspaceId}`,
        desiredDefaultBranch: "main",
        writeStatus: "read_only",
      })
      await db.insert(conversations).values({
        id: conversationId,
        orgId: seed.orgId,
        userId: seed.userId,
        workspaceId,
        name: "Files status conversation",
        source: "ui",
      })
    })
  })

  afterAll(async () => {
    if (!seed) return
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.delete(sandboxLocks).where(eq(sandboxLocks.orgId, seed.orgId))
      await db.delete(conversations).where(eq(conversations.orgId, seed.orgId))
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    })
    await cleanupSeededOrg(seed)
  })

  function createApp(): OpenAPIHono<AppEnv> {
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", contextStorage(), withTestRequestLogger)
    app.use("*", backendOtelMiddleware())
    app.use("*", async (c, next) => {
      c.set("user", { id: seed.userId } as AppEnv["Variables"]["user"])
      c.set("session", {
        id: `sess_${seed.userId}`,
      } as AppEnv["Variables"]["session"])
      c.set("orgId", seed.orgId)
      c.set("orgSlug", seed.orgSlug)
      applyAttribution({
        "enduser.id": seed.userId,
        "ctxpipe.org.id": seed.orgId,
        "ctxpipe.org.slug": seed.orgSlug,
        "ctxpipe.actor.type": "user",
      })
      await withOrgIdContext({ id: seed.orgId, slug: seed.orgSlug }, next)
    })
    app.route("/conversations", conversationFileRoutes)
    return app
  }

  it("puts the loaded conversation id on the GET files/status root span", async () => {
    const res = await createApp().request(
      `/conversations/${conversationId}/files/status`,
      {
        headers: {
          cookie: seed.cookie,
          baggage: "ctxpipe.conversation.id=conv_SPOOFED",
          "x-request-id": "req_files_status",
        },
      },
    )

    expect([400, 409]).toContain(res.status)
    const span = spans.serverSpan()
    expect(span?.attributes).toMatchObject({
      "ctxpipe.conversation.id": conversationId,
      "ctxpipe.org.id": seed.orgId,
      "ctxpipe.org.slug": seed.orgSlug,
      "request.id": "req_files_status",
    })
    expect(JSON.stringify(span?.attributes)).not.toContain("conv_SPOOFED")
  })

  it("omits conversation id on the GET files/status 404 root span", async () => {
    const missingId = generateObjectId("conv")
    const res = await createApp().request(
      `/conversations/${missingId}/files/status`,
      {
        headers: {
          cookie: seed.cookie,
          baggage: "ctxpipe.conversation.id=conv_SPOOFED",
          "x-request-id": "req_files_status_404",
        },
      },
    )

    expect(res.status).toBe(404)
    const span = spans.serverSpan()
    expect(span?.attributes).toMatchObject({
      "ctxpipe.org.id": seed.orgId,
      "ctxpipe.org.slug": seed.orgSlug,
      "request.id": "req_files_status_404",
    })
    expect(span?.attributes["ctxpipe.conversation.id"]).toBeUndefined()
    expect(JSON.stringify(span?.attributes)).not.toContain("conv_SPOOFED")
  })
})
