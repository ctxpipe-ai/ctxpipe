import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  cleanupSeededOrg,
  describeWithDatabase,
  type SeededOrg,
  seedOrg,
} from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { getAuth } from "../../auth/config.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { members, users } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import { generateObjectId } from "../../lib/id.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationRoutes } from "./conversations.js"

const now = new Date("2026-09-14T00:00:00.000Z")

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .map((part) => part.split(";")[0]?.trim())
    .filter((part): part is string => Boolean(part))
    .join("; ")
  if (!cookie) throw new Error("signUpEmail did not set a session cookie")
  return cookie
}

describeWithDatabase("GET /conversations org-service", () => {
  let seed: SeededOrg
  let memberUserId = ""
  let memberCookie = ""
  const serviceConversationId = generateObjectId("conv")
  const userMcpConversationId = generateObjectId("conv")

  beforeAll(async () => {
    seed = await seedOrg()
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const origin = process.env.AUTH_BASE_URL ?? "http://localhost:3000"
    const signUp = await getAuth().api.signUpEmail({
      body: {
        name: "Conversation member",
        email: `member-${suffix}@example.com`,
        password: "integration-member-password",
      },
      headers: new Headers({ origin }),
      asResponse: true,
    })
    if (!signUp.ok) {
      throw new Error(`member signUpEmail failed: ${signUp.status}`)
    }
    const signedUp = (await signUp.json()) as { user: { id: string } }
    memberUserId = signedUp.user.id
    memberCookie = sessionCookie(signUp)
    await getSystemDb()
      .insert(members)
      .values({
        id: generateObjectId("member"),
        organizationId: seed.orgId,
        userId: memberUserId,
        role: "member",
        createdAt: new Date(),
      })
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(conversations).values([
        {
          id: serviceConversationId,
          orgId: seed.orgId,
          userId: null,
          name: "Org MCP service",
          source: "mcp",
          lastMessageAt: now,
        },
        {
          id: userMcpConversationId,
          orgId: seed.orgId,
          userId: seed.userId,
          name: "User MCP",
          source: "mcp",
          lastMessageAt: now,
        },
      ])
    })
  })

  afterAll(async () => {
    if (!seed) return
    await getSystemDb()
      .delete(conversations)
      .where(eq(conversations.orgId, seed.orgId))
    if (memberUserId) {
      await getSystemDb()
        .delete(members)
        .where(eq(members.userId, memberUserId))
      await getSystemDb().delete(users).where(eq(users.id, memberUserId))
    }
    await cleanupSeededOrg(seed)
  })

  function createApp(userId: string): OpenAPIHono<AppEnv> {
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", contextStorage(), withTestRequestLogger)
    app.use("*", async (c, next) => {
      c.set("user", { id: userId } as AppEnv["Variables"]["user"])
      c.set("session", {
        id: `sess_${userId}`,
      } as AppEnv["Variables"]["session"])
      c.set("orgId", seed.orgId)
      c.set("orgSlug", seed.orgSlug)
      await withOrgIdContext({ id: seed.orgId, slug: seed.orgSlug }, next)
    })
    app.route("/conversations", conversationRoutes)
    return app
  }

  it("returns 403 when a member lists MCP service conversations", async () => {
    const res = await createApp(memberUserId).request(
      "/conversations?source=mcp-service&first=10",
      { headers: { cookie: memberCookie } },
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Forbidden" })
  })

  it("lists org-service MCP threads for an admin", async () => {
    const res = await createApp(seed.userId).request(
      "/conversations?source=mcp-service&first=10",
      { headers: { cookie: seed.cookie } },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ id: string; userId: string | null; source: string | null }>
    }
    expect(body.items).toEqual([
      expect.objectContaining({
        id: serviceConversationId,
        userId: null,
        source: "mcp",
      }),
    ])
    expect(body.items.map((item) => item.id)).not.toContain(
      userMcpConversationId,
    )
  })

  it("keeps source=mcp as the signed-in user's threads", async () => {
    const res = await createApp(seed.userId).request(
      "/conversations?source=mcp&first=10",
      { headers: { cookie: seed.cookie } },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ id: string; userId: string | null }>
    }
    expect(body.items).toEqual([
      expect.objectContaining({
        id: userMcpConversationId,
        userId: seed.userId,
      }),
    ])
    expect(body.items.map((item) => item.id)).not.toContain(
      serviceConversationId,
    )
  })

  it("returns an org-service thread for an admin after the user-scoped lookup misses", async () => {
    const res = await createApp(seed.userId).request(
      `/conversations/${serviceConversationId}`,
      { headers: { cookie: seed.cookie } },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      conversation: { id: string; userId: string | null; source: string | null }
    }
    expect(body.conversation).toEqual(
      expect.objectContaining({
        id: serviceConversationId,
        userId: null,
        source: "mcp",
      }),
    )
  })

  it("returns 404 when a member cannot see an org-service thread", async () => {
    const res = await createApp(memberUserId).request(
      `/conversations/${serviceConversationId}`,
      { headers: { cookie: memberCookie } },
    )

    expect(res.status).toBe(404)
  })
})
