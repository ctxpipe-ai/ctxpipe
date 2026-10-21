import { OpenAPIHono } from "@hono/zod-openapi"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationFileRoutes } from "./conversation-files-routes.js"

// The raw route uses the same middleware and conversation lookup as the blob
// route, so it refuses the same callers with the same answers.
describe("GET /conversations/:id/files/raw over HTTP", () => {
  let seed: SeededOrg
  const workspaceId = generateObjectId("ws")
  const otherUsersConversationId = generateObjectId("conv")

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId: seed.orgId,
        slug: `ws-${workspaceId.slice(-8)}`,
        displayName: "Raw file route",
        workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${workspaceId}`,
        desiredDefaultBranch: "main",
        writeStatus: "read_only",
      })
      await db.insert(conversations).values({
        id: otherUsersConversationId,
        orgId: seed.orgId,
        userId: `user_${generateObjectId("other")}`,
        workspaceId,
        name: "Another user's conversation",
        source: "ui",
      })
    })
  })

  afterAll(async () => {
    if (!seed) return
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.delete(conversations).where(eq(conversations.orgId, seed.orgId))
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    })
    await cleanupSeededOrg(seed)
  })

  function createApp(authenticated = true): OpenAPIHono<AppEnv> {
    const app = new OpenAPIHono<AppEnv>()
    app.use("*", contextStorage(), withTestRequestLogger)
    app.use("*", async (c, next) => {
      if (authenticated) {
        c.set("user", { id: seed.userId } as AppEnv["Variables"]["user"])
        c.set("session", {
          id: `sess_${seed.userId}`,
        } as AppEnv["Variables"]["session"])
      }
      c.set("orgId", seed.orgId)
      c.set("orgSlug", seed.orgSlug)
      await withOrgIdContext({ id: seed.orgId, slug: seed.orgSlug }, next)
    })
    app.route("/conversations", conversationFileRoutes)
    return app
  }

  async function read(
    kind: "raw" | "blob",
    conversationId: string,
    app = createApp(),
  ) {
    const response = await app.request(
      `/conversations/${conversationId}/files/${kind}?path=logo.png`,
    )
    return { status: response.status, body: await response.json() }
  }

  it("answers 401 without a user", async () => {
    expect(
      await read("raw", otherUsersConversationId, createApp(false)),
    ).toEqual({ status: 401, body: { error: "Unauthorized" } })
  })

  it("answers 404 for another user's conversation, as the blob route does", async () => {
    expect({
      raw: await read("raw", otherUsersConversationId),
      blob: await read("blob", otherUsersConversationId),
    }).toEqual({
      raw: { status: 404, body: { error: "Not found" } },
      blob: { status: 404, body: { error: "Not found" } },
    })
  })

  it("answers 404 for a conversation that does not exist", async () => {
    expect(await read("raw", generateObjectId("conv"))).toEqual({
      status: 404,
      body: { error: "Not found" },
    })
  })
})
