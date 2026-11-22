import { resolve } from "node:path"

import type { ModelMessage } from "@tanstack/ai"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  chatInterrupts,
  chatRuns,
  chatThreads,
} from "../../db/schema/chat-persistence.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"

config({
  path: resolve(import.meta.dirname, "../../../.env.local"),
  quiet: true,
})

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required; run pnpm --filter @ctxpipe/backend test against a migrated Postgres",
  )
}

const runId = `chatpersist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `${runId}_org`,
  slug: `${runId}-org`,
  name: "Chat persistence org",
}
const workspaceId = `ws_${runId}`
const conversationId = `conv_${runId}`

beforeAll(async () => {
  initDb(databaseUrl)
  const now = new Date()
  await getSystemDb()
    .insert(organizations)
    .values({ id: org.id, name: org.name, slug: org.slug, createdAt: now })
  await withOrgDbContext(org.id, async (db) => {
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId: org.id,
      slug: `ws-${runId}`,
      displayName: "Chat persistence workspace",
      workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${runId}`,
    })
    await db.insert(conversations).values({
      id: conversationId,
      orgId: org.id,
      name: "Persisted thread",
      workspaceId,
    })
  })
})

afterAll(async () => {
  try {
    await withOrgDbContext(org.id, async (db) => {
      await db
        .delete(chatInterrupts)
        .where(eq(chatInterrupts.threadId, conversationId))
      await db.delete(chatRuns).where(eq(chatRuns.threadId, conversationId))
      await db
        .delete(chatThreads)
        .where(eq(chatThreads.threadId, conversationId))
      await db.delete(conversations).where(eq(conversations.id, conversationId))
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
  } finally {
    await closeDb()
  }
})

describe("workspaceChatPersistence", () => {
  it("saves and loads a thread with reasoning parts", async () => {
    const persistence = workspaceChatPersistence()
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: "answer",
        thinking: [{ content: "think" }],
      },
    ]
    await withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
      await persistence.stores.messages.saveThread(conversationId, messages)
      const loaded =
        await persistence.stores.messages.loadThread(conversationId)
      expect(loaded).toEqual(messages)
    })
  })

  it("stores chat text that holds a NUL character", async () => {
    const persistence = workspaceChatPersistence()
    const nul = "before\u0000after"
    await withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
      await persistence.stores.messages.saveThread(conversationId, [
        { role: "tool", toolCallId: "call_1", content: nul },
      ])
      expect(
        await persistence.stores.messages.loadThread(conversationId),
      ).toEqual([
        { role: "tool", toolCallId: "call_1", content: "beforeafter" },
      ])

      const token = `ghp_${"a".repeat(36)}`
      await persistence.stores.messages.saveThread(conversationId, [
        {
          role: "tool",
          toolCallId: "call_2",
          content: token.split("").join("\u0000"),
        },
      ])
      const [saved] =
        await persistence.stores.messages.loadThread(conversationId)
      expect(saved?.content).not.toContain(token)

      const id = `${runId}-nul`
      await persistence.stores.runs.createOrResume({
        runId: id,
        threadId: conversationId,
        startedAt: Date.now(),
      })
      await persistence.stores.runs.update(id, {
        status: "failed",
        error: { message: nul },
      })
      expect((await persistence.stores.runs.get(id))?.error?.message).toBe(
        "beforeafter",
      )

      await persistence.stores.interrupts.create({
        interruptId: id,
        runId: id,
        threadId: conversationId,
        requestedAt: Date.now(),
        payload: { text: nul },
      })
      await persistence.stores.interrupts.resolve(id, { text: nul })
      expect(await persistence.stores.interrupts.get(id)).toMatchObject({
        payload: { text: "beforeafter" },
        response: { text: "beforeafter" },
      })

      await persistence.stores.metadata.set("nul-test", id, { text: nul })
      expect(await persistence.stores.metadata.get("nul-test", id)).toEqual({
        text: "beforeafter",
      })
      await persistence.stores.metadata.delete("nul-test", id)
    })
  })
})

it("does not fabricate a persisted run when another organization owns its id", async () => {
  const otherOrg = {
    id: `${runId}_other`,
    slug: `${runId}-other`,
    name: "Other org",
  }
  const persistence = workspaceChatPersistence()
  await getSystemDb()
    .insert(organizations)
    .values({ ...otherOrg, createdAt: new Date() })
  try {
    await withOrgIdContext(org, () =>
      persistence.stores.runs.createOrResume({
        runId,
        threadId: conversationId,
        startedAt: Date.now(),
      }),
    )
    await expect(
      withOrgIdContext(otherOrg, () =>
        persistence.stores.runs.createOrResume({
          runId,
          threadId: "other-thread",
          startedAt: Date.now(),
        }),
      ),
    ).rejects.toThrow()
    expect(
      await withOrgIdContext(otherOrg, () =>
        persistence.stores.runs.get(runId),
      ),
    ).toBeNull()
  } finally {
    await withOrgDbContext(otherOrg.id, (db) =>
      db.delete(chatRuns).where(eq(chatRuns.orgId, otherOrg.id)),
    )
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, otherOrg.id))
  }
})

it("rejects a run id owned by another thread in the same organization", async () => {
  const runs = workspaceChatPersistence().stores.runs
  await withOrgIdContext(org, async () => {
    const id = `${runId}-same-org`
    const first = await runs.createOrResume({
      runId: id,
      threadId: conversationId,
      startedAt: Date.now(),
    })
    await expect(
      runs.createOrResume({
        runId: id,
        threadId: `${conversationId}-other`,
        startedAt: Date.now(),
      }),
    ).rejects.toThrow("another conversation")
    expect(await runs.get(id)).toEqual(first)
  })
})
