import { OpenAPIHono } from "@hono/zod-openapi"
import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import type { AppEnv } from "../../app/env.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { chatRuns } from "../../db/schema/chat-persistence.js"
import { conversations } from "../../db/schema/conversations.js"
import { generateObjectId } from "../../lib/id.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationRoutes } from "./conversations.js"

const base = new Date("2026-10-01T00:00:00.000Z")

describe("GET /conversations lastTurn", () => {
  let caller: SeededOrg
  const workspaceId = generateObjectId("ws")
  const ids = {
    noRuns: generateObjectId("conv"),
    running: generateObjectId("conv"),
    completed: generateObjectId("conv"),
    failed: generateObjectId("conv"),
    aborted: generateObjectId("conv"),
    interrupted: generateObjectId("conv"),
    newest: generateObjectId("conv"),
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    caller = await seedOrg()
    const names = Object.keys(ids) as Array<keyof typeof ids>
    await withOrgDbContext(caller.orgId, async (db) => {
      await db.insert(conversations).values(
        names.map((name, index) => ({
          id: ids[name],
          orgId: caller.orgId,
          userId: caller.userId,
          workspaceId,
          name,
          source: "ui",
          lastMessageAt: new Date(base.getTime() + index * 1000),
        })),
      )
      const run = (
        name: keyof typeof ids,
        status: string,
        startedAt: number,
        finishedAt?: number,
      ) => ({
        runId: generateObjectId("run"),
        threadId: ids[name],
        orgId: caller.orgId,
        status,
        startedAt,
        finishedAt: finishedAt ?? null,
      })
      await db.insert(chatRuns).values([
        run("running", "running", 1000),
        run("completed", "completed", 2000, 2500),
        run("failed", "failed", 3000, 3100),
        run("aborted", "aborted", 4000, 4200),
        run("interrupted", "interrupted", 5000),
        // An older failed run does not count: the newest run decides.
        run("newest", "failed", 6000, 6100),
        run("newest", "completed", 7000, 7300),
      ])
    })
  })

  afterAll(async () => {
    if (!caller) return
    await getSystemDb()
      .delete(conversations)
      .where(inArray(conversations.orgId, [caller.orgId]))
    await cleanupSeededOrg(caller)
  })

  function list() {
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
    return app.request(`/conversations?workspaceId=${workspaceId}&first=20`, {
      headers: { cookie: caller.cookie },
    })
  }

  it("returns the status and end time of the newest run of each conversation", async () => {
    const res = await list()

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ id: string; lastTurn: unknown }>
    }
    const turn = (id: string) =>
      body.items.find((item) => item.id === id)?.lastTurn
    expect(turn(ids.noRuns)).toBeNull()
    // A running turn has no end time, so `at` is its start.
    expect(turn(ids.running)).toEqual({ status: "running", at: 1000 })
    expect(turn(ids.completed)).toEqual({ status: "completed", at: 2500 })
    expect(turn(ids.failed)).toEqual({ status: "failed", at: 3100 })
    expect(turn(ids.aborted)).toEqual({ status: "aborted", at: 4200 })
    expect(turn(ids.interrupted)).toEqual({ status: "interrupted", at: 5000 })
    expect(turn(ids.newest)).toEqual({ status: "completed", at: 7300 })
  })
})
