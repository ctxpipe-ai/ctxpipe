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
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { withSandboxLockIfFree } from "../../domain/workspaces/sandbox-lock-store.js"
import { generateObjectId } from "../../lib/id.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationFileRoutes } from "./conversation-files-routes.js"

describeWithDatabase("conversation Files reads during a turn", () => {
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
        displayName: "Files during a turn",
        workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${workspaceId}`,
        desiredDefaultBranch: "main",
        writeStatus: "read_only",
      })
      await db.insert(conversations).values({
        id: conversationId,
        orgId: seed.orgId,
        userId: seed.userId,
        workspaceId,
        name: "Files during a turn",
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
    app.use("*", async (c, next) => {
      c.set("user", { id: seed.userId } as AppEnv["Variables"]["user"])
      c.set("session", {
        id: `sess_${seed.userId}`,
      } as AppEnv["Variables"]["session"])
      c.set("orgId", seed.orgId)
      c.set("orgSlug", seed.orgSlug)
      await withOrgIdContext({ id: seed.orgId, slug: seed.orgSlug }, next)
    })
    app.route("/conversations", conversationFileRoutes)
    return app
  }

  /** Hold the conversation lock as a chat turn does, until `release`. */
  async function holdTurnLock() {
    let release = () => {}
    let acquired = () => {}
    const isAcquired = new Promise<void>((resolve) => {
      acquired = resolve
    })
    const held = withSandboxLockIfFree(
      seed.orgId,
      `chat-thread:${conversationId}`,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
          acquired()
        }),
    )
    await isAcquired
    return async () => {
      release()
      expect((await held).busy).toBe(false)
    }
  }

  for (const route of ["tree", "status"] as const) {
    it(`answers GET files/${route} at once while a turn holds the conversation`, async () => {
      const releaseTurn = await holdTurnLock()
      try {
        const answered = Promise.resolve(
          createApp().request(
            `/conversations/${conversationId}/files/${route}`,
            { headers: { cookie: seed.cookie } },
          ),
        ).then((res) => res.status)
        const blocked = new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 3_000),
        )
        // 409 is the "sandbox not ready" answer the Files pane treats as
        // "keep the last tree", not as an error.
        expect(await Promise.race([answered, blocked])).toBe(409)
      } finally {
        await releaseTurn()
      }
    })
  }
})
