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
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { generateObjectId } from "../../lib/id.js"
import { applyAttribution } from "../../observability/attribution.js"
import { backendOtelMiddleware } from "../../observability/http.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationRoutes } from "./conversations.js"

const now = new Date("2026-09-14T00:00:00.000Z")
const spans = recordSpans()

describeWithDatabase("conversation HTTP attribution", () => {
  let seed: SeededOrg
  const conversationId = generateObjectId("conv")

  beforeAll(async () => {
    seed = await seedOrg()
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(conversations).values({
        id: conversationId,
        orgId: seed.orgId,
        userId: seed.userId,
        name: "Attribution conversation",
        source: "ui",
        lastMessageAt: now,
      })
    })
  })

  afterAll(async () => {
    if (!seed) return
    await getSystemDb()
      .delete(conversations)
      .where(eq(conversations.orgId, seed.orgId))
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
    app.route("/conversations", conversationRoutes)
    return app
  }

  it("puts the loaded conversation id on the GET 200 root span", async () => {
    const res = await createApp().request(`/conversations/${conversationId}`, {
      headers: {
        cookie: seed.cookie,
        baggage: "ctxpipe.conversation.id=conv_SPOOFED",
        "x-request-id": "req_conv_get",
      },
    })

    expect(res.status).toBe(200)
    const span = spans.serverSpan()
    expect(span?.attributes).toMatchObject({
      "ctxpipe.conversation.id": conversationId,
      "ctxpipe.org.id": seed.orgId,
      "ctxpipe.org.slug": seed.orgSlug,
      "request.id": "req_conv_get",
    })
    expect(JSON.stringify(span?.attributes)).not.toContain("conv_SPOOFED")
  })

  it("omits conversation id on the GET by id 404 root span", async () => {
    const missingId = generateObjectId("conv")
    const res = await createApp().request(`/conversations/${missingId}`, {
      headers: {
        cookie: seed.cookie,
        baggage: "ctxpipe.conversation.id=conv_SPOOFED",
        "x-request-id": "req_conv_get_404",
      },
    })

    expect(res.status).toBe(404)
    const span = spans.serverSpan()
    expect(span?.attributes).toMatchObject({
      "ctxpipe.org.id": seed.orgId,
      "ctxpipe.org.slug": seed.orgSlug,
      "request.id": "req_conv_get_404",
    })
    expect(span?.attributes["ctxpipe.conversation.id"]).toBeUndefined()
    expect(JSON.stringify(span?.attributes)).not.toContain("conv_SPOOFED")
  })

  it("omits conversation id on the GET /chat 404 root span", async () => {
    const missingId = generateObjectId("conv")
    const res = await createApp().request(`/conversations/${missingId}/chat`, {
      headers: {
        cookie: seed.cookie,
        baggage: "ctxpipe.conversation.id=conv_SPOOFED",
        "x-request-id": "req_conv_chat_404",
      },
    })

    expect(res.status).toBe(404)
    const span = spans.serverSpan()
    expect(span?.attributes).toMatchObject({
      "ctxpipe.org.id": seed.orgId,
      "request.id": "req_conv_chat_404",
    })
    expect(span?.attributes["ctxpipe.conversation.id"]).toBeUndefined()
    expect(JSON.stringify(span?.attributes)).not.toContain("conv_SPOOFED")
  })
})
