import { resolve } from "node:path"
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
import { chatThreads } from "../../db/schema/chat-persistence.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaces } from "../../db/schema/workspaces.js"
import type { ModelMessage } from "@tanstack/ai"
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
      await db.delete(chatThreads).where(eq(chatThreads.threadId, conversationId))
      await db.delete(conversations).where(eq(conversations.id, conversationId))
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, org.id))
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
      const loaded = await persistence.stores.messages.loadThread(conversationId)
      expect(loaded).toEqual(messages)
    })
  })
})
