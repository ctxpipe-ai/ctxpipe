import { OpenAPIHono } from "@hono/zod-openapi"
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  cleanupSeededOrg,
  describeWithDatabase,
  type SeededOrg,
  seedOrg,
} from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, initDb, withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { generateObjectId } from "../../lib/id.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationRoutes } from "./conversations.js"

const now = new Date("2026-10-01T00:00:00.000Z")

describeWithDatabase("PATCH /conversations/{id} scope", () => {
  let caller: SeededOrg
  let other: SeededOrg
  const ownId = generateObjectId("conv")
  const otherOrgId = generateObjectId("conv")
  const otherMemberId = generateObjectId("conv")

  beforeAll(async () => {
    caller = await seedOrg()
    other = await seedOrg()
    await withOrgDbContext(caller.orgId, async (db) => {
      await db.insert(conversations).values([
        {
          id: ownId,
          orgId: caller.orgId,
          userId: caller.userId,
          name: "Own conversation",
          source: "ui",
          lastMessageAt: now,
        },
        {
          id: otherMemberId,
          orgId: caller.orgId,
          userId: other.userId,
          name: "Other member conversation",
          source: "ui",
          lastMessageAt: now,
        },
      ])
    })
    await withOrgDbContext(other.orgId, async (db) => {
      await db.insert(conversations).values({
        id: otherOrgId,
        orgId: other.orgId,
        userId: other.userId,
        name: "Other org conversation",
        source: "ui",
        lastMessageAt: now,
      })
    })
  })

  afterAll(async () => {
    const seeds = [caller, other].filter(Boolean)
    if (seeds.length === 0) return
    await getSystemDb()
      .delete(conversations)
      .where(
        inArray(
          conversations.orgId,
          seeds.map((seed) => seed.orgId),
        ),
      )
    for (const seed of seeds) {
      // cleanupSeededOrg closes the pool, so open it again for the next seed.
      initDb(process.env.DATABASE_URL ?? "")
      await cleanupSeededOrg(seed)
    }
  })

  function createApp(): OpenAPIHono<AppEnv> {
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", contextStorage(), withTestRequestLogger)
    app.use("*", async (c, next) => {
      c.set("user", { id: caller.userId } as AppEnv["Variables"]["user"])
      c.set("session", {
        id: `sess_${caller.userId}`,
      } as AppEnv["Variables"]["session"])
      c.set("orgId", caller.orgId)
      c.set("orgSlug", caller.orgSlug)
      await withOrgIdContext({ id: caller.orgId, slug: caller.orgSlug }, next)
    })
    app.route("/conversations", conversationRoutes)
    return app
  }

  function rename(conversationId: string, name: string) {
    return createApp().request(`/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { cookie: caller.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
  }

  async function storedName(orgId: string, conversationId: string) {
    const [row] = await withOrgDbContext(orgId, (db) =>
      db
        .select({ name: conversations.name })
        .from(conversations)
        .where(eq(conversations.id, conversationId)),
    )
    return row?.name
  }

  it("renames a conversation of the caller in the caller's org", async () => {
    const res = await rename(ownId, "Renamed conversation")

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: ownId,
      name: "Renamed conversation",
    })
    expect(await storedName(caller.orgId, ownId)).toBe("Renamed conversation")
  })

  it("rejects a conversation of another org with 404", async () => {
    const res = await rename(otherOrgId, "Hijacked")

    expect(res.status).toBe(404)
    expect(await storedName(other.orgId, otherOrgId)).toBe(
      "Other org conversation",
    )
  })

  it("rejects a conversation of another member of the same org with 404", async () => {
    const res = await rename(otherMemberId, "Hijacked")

    expect(res.status).toBe(404)
    expect(await storedName(caller.orgId, otherMemberId)).toBe(
      "Other member conversation",
    )
  })
})
