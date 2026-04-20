import { and, desc, eq, lt, or, sql } from "drizzle-orm"
import { createError } from "evlog"
import { requireCurrentOrgId, requireCurrentUserId } from "../auth/context.js"
import { conversations } from "../db/schema/conversations.js"
import { getOrgDb } from "../db/client.js"
import {
  buildPageInfo,
  decodeCursor,
  encodeCursor,
  type PageInfo,
} from "../lib/pagination.js"

export type ConversationRecord = typeof conversations.$inferSelect

type ConversationCursor = {
  lastMessageAt: string | null
  createdAt: string
  id: string
}

function encodeConversationCursor(row: ConversationRecord): string {
  return encodeCursor({
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  })
}

export async function ensureConversation(input: {
  id: string
  source?: string
}): Promise<ConversationRecord> {
  const orgId = requireCurrentOrgId()
  const userId = requireCurrentUserId()
  const db = getOrgDb()

  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, input.id),
        eq(conversations.orgId, orgId),
        eq(conversations.userId, userId),
      ),
    )
    .limit(1)

  if (existing) return existing

  const [idTaken] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(eq(conversations.id, input.id), eq(conversations.orgId, orgId)),
    )
    .limit(1)

  if (idTaken) {
    throw createError({
      message: "Conversation not found",
      status: 404,
      why: "Conversation id is not available for the current user",
    })
  }

  const [created] = await db
    .insert(conversations)
    .values({
      id: input.id,
      orgId,
      userId,
      source: input.source ?? null,
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
  const userId = requireCurrentUserId()
  const db = getOrgDb()
  await db
    .update(conversations)
    .set({
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.orgId, orgId),
        eq(conversations.userId, userId),
      ),
    )
}

export async function listConversations(input?: {
  source?: string
}): Promise<ConversationRecord[]> {
  const orgId = requireCurrentOrgId()
  const userId = requireCurrentUserId()
  const db = getOrgDb()
  if (input?.source) {
    return db.query.conversations.findMany({
      where: {
        orgId: { eq: orgId },
        userId: { eq: userId },
        source: { eq: input.source },
      },
      orderBy: (t, { desc }) => [
        desc(t.lastMessageAt),
        desc(t.createdAt),
        desc(t.id),
      ],
    })
  }
  return db.query.conversations.findMany({
    where: { orgId: { eq: orgId }, userId: { eq: userId } },
    orderBy: (t, { desc }) => [
      desc(t.lastMessageAt),
      desc(t.createdAt),
      desc(t.id),
    ],
  })
}

export async function listConversationsPaginated(input: {
  source?: string
  first: number
  after?: string
}): Promise<{ items: ConversationRecord[]; pageInfo: PageInfo }> {
  const orgId = requireCurrentOrgId()
  const userId = requireCurrentUserId()
  const db = getOrgDb()
  const { first, after } = input

  const baseConditions = [
    eq(conversations.orgId, orgId),
    eq(conversations.userId, userId),
    input.source ? eq(conversations.source, input.source) : null,
  ].filter(Boolean) as ReturnType<typeof eq>[]

  let cursorCondition: ReturnType<typeof or> | null = null
  const cursor =
    after && after !== "" ? decodeCursor<ConversationCursor>(after) : null

  if (after && after !== "" && !cursor) {
    return {
      items: [],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: true,
        startCursor: null,
        endCursor: null,
      },
    }
  }

  if (cursor) {
    const cursorLastMessageAt = cursor.lastMessageAt
      ? new Date(cursor.lastMessageAt)
      : null
    const cursorCreatedAt = new Date(cursor.createdAt)

    if (cursorLastMessageAt) {
      cursorCondition = or(
        lt(conversations.lastMessageAt, cursorLastMessageAt),
        sql`${conversations.lastMessageAt} IS NULL`,
        and(
          eq(conversations.lastMessageAt, cursorLastMessageAt),
          lt(conversations.createdAt, cursorCreatedAt),
        ),
        and(
          eq(conversations.lastMessageAt, cursorLastMessageAt),
          eq(conversations.createdAt, cursorCreatedAt),
          lt(conversations.id, cursor.id),
        ),
      )
    } else {
      cursorCondition = and(
        sql`${conversations.lastMessageAt} IS NULL`,
        or(
          lt(conversations.createdAt, cursorCreatedAt),
          and(
            eq(conversations.createdAt, cursorCreatedAt),
            lt(conversations.id, cursor.id),
          ),
        ),
      )
    }
  }

  const whereClause =
    cursorCondition !== null
      ? and(...baseConditions, cursorCondition)
      : and(...baseConditions)

  const rows = await db
    .select()
    .from(conversations)
    .where(whereClause)
    .orderBy(
      sql`${conversations.lastMessageAt} DESC NULLS LAST`,
      desc(conversations.createdAt),
      desc(conversations.id),
    )
    .limit(first + 1)

  return buildPageInfo({
    items: rows,
    limit: first,
    after,
    encodeCursor: encodeConversationCursor,
  })
}

export async function getConversation(
  conversationId: string,
): Promise<ConversationRecord | null> {
  const orgId = requireCurrentOrgId()
  const userId = requireCurrentUserId()
  const db = getOrgDb()
  return (
    (await db.query.conversations.findFirst({
      where: {
        id: { eq: conversationId },
        orgId: { eq: orgId },
        userId: { eq: userId },
      },
    })) ?? null
  )
}

export async function updateConversation(
  conversationId: string,
  input: { name: string },
): Promise<ConversationRecord | null> {
  const orgId = requireCurrentOrgId()
  const userId = requireCurrentUserId()
  const db = getOrgDb()
  const [updated] = await db
    .update(conversations)
    .set({ name: input.name, updatedAt: new Date() })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.orgId, orgId),
        eq(conversations.userId, userId),
      ),
    )
    .returning()
  return updated ?? null
}

export async function deleteConversation(
  conversationId: string,
): Promise<boolean> {
  const orgId = requireCurrentOrgId()
  const userId = requireCurrentUserId()
  const db = getOrgDb()
  const [deleted] = await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.orgId, orgId),
        eq(conversations.userId, userId),
      ),
    )
    .returning({ id: conversations.id })
  return deleted != null
}
