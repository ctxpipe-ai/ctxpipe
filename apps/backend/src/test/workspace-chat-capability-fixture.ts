import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"

import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { conversations } from "../db/schema/conversations.js"
import { sandboxLocks } from "../db/schema/sandbox-locks.js"
import { workspaces } from "../db/schema/workspaces.js"
import { mintWorkspaceChatRunCapability } from "../domain/workspaces/workspace-chat-run-capability.js"
import { generateObjectId } from "../lib/id.js"

export type ChatCapabilityFixture = {
  orgId: string
  orgSlug: string
  workspaceId: string
  conversationId: string
  lockOwner: string
  /** A model capability bound to the held conversation lock. */
  mint: () => Promise<string>
  cleanup: () => Promise<void>
}

/**
 * An org, a Workspace, a conversation, and its held chat lock: what a chat
 * turn has when it mints its model capability. Call after `initDb`.
 */
export async function seedChatCapability(
  authSecret: string,
): Promise<ChatCapabilityFixture> {
  const orgId = generateObjectId("org")
  const orgSlug = `chat-cap-${orgId.slice(-8).toLowerCase()}`
  const workspaceId = generateObjectId("ws")
  const conversationId = generateObjectId("conv")
  const lockOwner = randomUUID()
  const sha = "a".repeat(40)
  const repoUrl = `https://github.com/fixture/${workspaceId}`
  await getSystemDb().insert(organizations).values({
    id: orgId,
    name: "Chat capability org",
    slug: orgSlug,
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, async (db) => {
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: `ws-${workspaceId.slice(-8).toLowerCase()}`,
      displayName: "Chat capability workspace",
      workspaceRepositoryUrl: repoUrl,
      desiredGeneration: 1,
      desiredSha: sha,
      desiredDefaultBranch: "main",
    })
    await db.insert(conversations).values({
      id: conversationId,
      orgId,
      workspaceId,
      name: "Chat capability conversation",
      source: "ui",
    })
    await db.insert(sandboxLocks).values({
      orgId,
      key: `chat-thread:${conversationId}`,
      owner: lockOwner,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
  })
  return {
    orgId,
    orgSlug,
    workspaceId,
    conversationId,
    lockOwner,
    mint: () =>
      mintWorkspaceChatRunCapability({
        authSecret,
        orgId,
        orgSlug,
        conversationId,
        expectedOwner: lockOwner,
        revision: {
          workspaceId,
          generation: 1,
          remote: { url: repoUrl, connectionId: null },
          sha,
          defaultBranch: "main",
          access: "read",
        },
        purpose: "workspace-chat-model",
      }),
    cleanup: async () => {
      await withOrgDbContext(orgId, async (db) => {
        await db.delete(sandboxLocks).where(eq(sandboxLocks.orgId, orgId))
        await db.delete(conversations).where(eq(conversations.orgId, orgId))
        await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
    },
  }
}
