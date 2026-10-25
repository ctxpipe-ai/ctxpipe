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
import { chatRuns } from "../../db/schema/chat-persistence.js"
import { conversations } from "../../db/schema/conversations.js"
import { postgresSandboxLocks } from "../../domain/workspaces/sandbox-lock-store.js"
import { generateObjectId } from "../../lib/id.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationRoutes } from "./conversations.js"

const now = new Date("2026-10-01T00:00:00.000Z")

describeWithDatabase("DELETE /conversations/{id} scope", () => {
  let caller: SeededOrg
  let other: SeededOrg
  const ownId = generateObjectId("conv")
  const runningId = generateObjectId("conv")
  const startingId = generateObjectId("conv")
  const preparingId = generateObjectId("conv")
  const turnStartsId = generateObjectId("conv")
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
          id: runningId,
          orgId: caller.orgId,
          userId: caller.userId,
          name: "Running conversation",
          source: "ui",
          lastMessageAt: now,
        },
        {
          id: startingId,
          orgId: caller.orgId,
          userId: caller.userId,
          name: "Starting conversation",
          source: "ui",
          lastMessageAt: now,
        },
        {
          id: preparingId,
          orgId: caller.orgId,
          userId: caller.userId,
          name: "Preparing conversation",
          source: "ui",
          lastMessageAt: now,
        },
        {
          id: turnStartsId,
          orgId: caller.orgId,
          userId: caller.userId,
          name: "Turn starts conversation",
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

  function remove(conversationId: string) {
    return createApp().request(`/conversations/${conversationId}`, {
      method: "DELETE",
      headers: { cookie: caller.cookie },
    })
  }

  async function exists(orgId: string, conversationId: string) {
    const rows = await withOrgDbContext(orgId, (db) =>
      db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId)),
    )
    return rows.length === 1
  }

  it("rejects a conversation of another org with 404", async () => {
    const res = await remove(otherOrgId)

    expect(res.status).toBe(404)
    expect(await exists(other.orgId, otherOrgId)).toBe(true)
  })

  it("rejects a conversation of another member of the same org with 404", async () => {
    const res = await remove(otherMemberId)

    expect(res.status).toBe(404)
    expect(await exists(caller.orgId, otherMemberId)).toBe(true)
  })

  it("refuses with 409 turn_running while a turn runs, and keeps the conversation", async () => {
    await withOrgDbContext(caller.orgId, (db) =>
      db.insert(chatRuns).values({
        runId: generateObjectId("run"),
        threadId: runningId,
        orgId: caller.orgId,
        status: "running",
        startedAt: now.getTime(),
      }),
    )

    const res = await remove(runningId)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "turn_running" })
    expect(await exists(caller.orgId, runningId)).toBe(true)
  })

  it("answers 409 chat_starting while a prepare keeps the chat lock, and keeps the conversation", async () => {
    // A prepare (or a turn before it inserts its running row) holds this
    // lock with no running row. The delete waits a few seconds, then stops.
    const res = await postgresSandboxLocks(caller.orgId).withLock(
      `chat-thread:${startingId}`,
      async () => remove(startingId),
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "chat_starting" })
    expect(await exists(caller.orgId, startingId)).toBe(true)
  })

  it("waits for a short prepare to release the chat lock, then deletes", async () => {
    let releasePrepare = () => {}
    let prepareHolds = () => {}
    const holding = new Promise<void>((resolve) => {
      prepareHolds = resolve
    })
    const prepare = postgresSandboxLocks(caller.orgId).withLock(
      `chat-thread:${preparingId}`,
      () =>
        new Promise<void>((resolve) => {
          releasePrepare = resolve
          prepareHolds()
        }),
    )
    await holding
    const deleting = remove(preparingId)
    setTimeout(() => releasePrepare(), 500)
    await prepare

    const res = await deleting

    expect(res.status).toBe(204)
    expect(await exists(caller.orgId, preparingId)).toBe(false)
  })

  it("answers 409 turn_running when a turn starts while the delete waits", async () => {
    const res = await postgresSandboxLocks(caller.orgId).withLock(
      `chat-thread:${turnStartsId}`,
      async () => {
        const deleting = remove(turnStartsId)
        await withOrgDbContext(caller.orgId, (db) =>
          db.insert(chatRuns).values({
            runId: generateObjectId("run"),
            threadId: turnStartsId,
            orgId: caller.orgId,
            status: "running",
            startedAt: now.getTime(),
          }),
        )
        return deleting
      },
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "turn_running" })
    expect(await exists(caller.orgId, turnStartsId)).toBe(true)
  })

  it("deletes a conversation of the caller in the caller's org", async () => {
    const res = await remove(ownId)

    expect(res.status).toBe(204)
    expect(await exists(caller.orgId, ownId)).toBe(false)
  })
})
