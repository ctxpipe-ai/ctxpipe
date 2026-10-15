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
  deleteConversationThreadRecords,
  saveConversationSync,
  saveConversationTurnChanges,
} from "../../models/conversation-turn-changes.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { conversationFileRoutes } from "./conversation-files-routes.js"

describe("GET /conversations/:id/turns over HTTP", () => {
  let seed: SeededOrg
  const workspaceId = generateObjectId("ws")
  const conversationId = generateObjectId("conv")
  const otherConversationId = generateObjectId("conv")

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    seed = await seedOrg()
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId: seed.orgId,
        slug: `ws-${workspaceId.slice(-8)}`,
        displayName: "Turn changes route",
        workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${workspaceId}`,
        desiredDefaultBranch: "main",
        writeStatus: "read_only",
      })
      for (const id of [conversationId, otherConversationId])
        await db.insert(conversations).values({
          id,
          orgId: seed.orgId,
          userId: seed.userId,
          workspaceId,
          name: "Turn changes conversation",
          source: "ui",
        })
    })
  })

  afterAll(async () => {
    if (!seed) return
    await withOrgDbContext(seed.orgId, async (db) => {
      for (const id of [conversationId, otherConversationId])
        await deleteConversationThreadRecords(db, id)
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

  const get = (id: string, app = createApp()) =>
    app.request(`/conversations/${id}/turns`, {
      headers: { cookie: seed.cookie },
    })

  function turn(runId: string, n: number, path: string, finishedAt: number) {
    return {
      runId,
      turn: n,
      startTree: "a".repeat(40),
      endTree: "b".repeat(40),
      finishedAt,
      files: [
        { path, status: "modified" as const, additions: 3, deletions: 1 },
      ],
    }
  }

  it("answers 404 for a conversation that does not exist", async () => {
    const res = await get(generateObjectId("conv"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not found" })
  })

  it("answers 401 without a user", async () => {
    const res = await get(conversationId, createApp(false))
    expect(res.status).toBe(401)
  })

  it("answers empty lists for a conversation with no recorded turns", async () => {
    const res = await get(conversationId)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [], syncs: [] })
  })

  it("lists each turn's files in turn order, with its syncs, and only for this conversation", async () => {
    const save = (conversation: string, changes: ReturnType<typeof turn>) =>
      saveConversationTurnChanges({
        orgId: seed.orgId,
        conversationId: conversation,
        changes,
      })
    await save(conversationId, turn("run_b", 2, "b.md", 2))
    await save(conversationId, turn("run_a", 1, "a.md", 1))
    await save(otherConversationId, turn("run_other", 1, "other.md", 1))
    await saveConversationSync({
      orgId: seed.orgId,
      conversationId,
      sync: {
        trigger: "create_pr",
        pullRequest: {
          number: 7,
          url: "https://example.test/pr/7",
          opened: true,
        },
        branch: "ctxpipe/session",
        sha: "c".repeat(40),
        files: 2,
        treeUrl: "https://example.test/tree",
        turn: 2,
        syncedAt: "2026-01-01T00:00:00.000Z",
      },
    })

    const res = await get(conversationId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: unknown[]
      syncs: Array<{ sha: string; trigger: string }>
    }
    expect(body.items).toEqual([
      {
        runId: "run_a",
        turn: 1,
        files: [
          { path: "a.md", status: "modified", additions: 3, deletions: 1 },
        ],
      },
      {
        runId: "run_b",
        turn: 2,
        files: [
          { path: "b.md", status: "modified", additions: 3, deletions: 1 },
        ],
      },
    ])
    expect(body.syncs).toHaveLength(1)
    expect(body.syncs[0]).toMatchObject({
      sha: "c".repeat(40),
      trigger: "create_pr",
      pullRequest: { number: 7, opened: true },
    })
  })
})
