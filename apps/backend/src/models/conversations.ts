import { and, eq } from "drizzle-orm"
import { requireCurrentOrgId } from "src/auth/context.js"
import { conversations } from "src/db/schema/conversations.js"
import { getOrgDb } from "../db/client.js"

export type ConversationRecord = typeof conversations.$inferSelect

export async function ensureConversation(input: {
  id: string
  source?: string
}): Promise<ConversationRecord> {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()

  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.id), eq(conversations.orgId, orgId)))
    .limit(1)

  if (existing) return existing

  const [created] = await db
    .insert(conversations)
    .values({
      id: input.id,
      orgId,
      source: input.source ?? "ui",
      name: "New Chat",
    })
    .returning()

  if (!created) throw new Error("Failed to create conversation")
  return created
}

export async function touchConversationLastMessage(
  conversationId: string,
): Promise<void> {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  await db
    .update(conversations)
    .set({
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)),
    )
}

export async function listConversations(input?: {
  source?: string
}): Promise<ConversationRecord[]> {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  if (input?.source) {
    return db.query.conversations.findMany({
      where: {
        orgId: { eq: orgId },
        source: { eq: input.source },
      },
      orderBy: (t, { desc }) => [desc(t.lastMessageAt), desc(t.createdAt)],
    })
  }
  return db.query.conversations.findMany({
    where: { orgId: { eq: orgId } },
    orderBy: (t, { desc }) => [desc(t.lastMessageAt), desc(t.createdAt)],
  })
}

export async function getConversation(
  conversationId: string,
): Promise<ConversationRecord | null> {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  return (
    (await db.query.conversations.findFirst({
      where: {
        id: { eq: conversationId },
        orgId: { eq: orgId },
      },
    })) ?? null
  )
}
