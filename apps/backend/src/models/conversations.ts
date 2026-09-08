import {
  and,
  desc,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm"
import { createError } from "evlog"
import { requireCurrentOrgId, requireCurrentUserId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { withAmbientOrgDb } from "../db/org-sql.js"
import { conversations } from "../db/schema/conversations.js"
import { workspaces } from "../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import {
  buildPageInfo,
  decodeCursor,
  encodeCursor,
  type PageInfo,
} from "../lib/pagination.js"

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

function conversationSelection() {
  return {
    ...getTableColumns(conversations),
    lastChatPrNumber: sql<number | null>`case when exists (
      select 1 from ${workspaces}
      where ${workspaces.id} = ${conversations.workspaceId}
        and ${workspaces.orgId} = ${conversations.orgId}
        and ${workspaces.id} = ${conversations.lastChatPrRevision}->>'workspaceId'
        and ${workspaces.desiredGeneration}::text = ${conversations.lastChatPrRevision}->>'generation'
        and ${workspaces.workspaceRepositoryUrl} = ${conversations.lastChatPrRevision}->'remote'->>'url'
        and ${workspaces.githubConnectionId} is not distinct from ${conversations.lastChatPrRevision}->'remote'->>'connectionId'
        and ${workspaces.desiredDefaultBranch} = ${conversations.lastChatPrRevision}->>'defaultBranch'
    ) then ${conversations.lastChatPrNumber} else null end`,
  }
}

export type ConversationRecord = typeof conversations.$inferSelect

type ConversationCursor = {
  lastMessageAt: string
  id: string
}

function encodeConversationCursor(row: ConversationRecord): string {
  return encodeCursor({
    lastMessageAt: row.lastMessageAt?.toISOString() ?? "",
    id: row.id,
  })
}

export async function ensureConversation(input: {
  id: string
  source?: string
  workspaceId?: string
}): Promise<ConversationRecord> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    const db = getOrgDb()

    if (input.workspaceId) {
      const [workspace] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.id, input.workspaceId),
            eq(workspaces.orgId, orgId),
          ),
        )
        .limit(1)
      if (!workspace) {
        throw createError({
          message: "Workspace not found",
          status: 404,
          why: "Conversation create requires a Workspace in this organisation",
        })
      }
    }

    const [existing] = await db
      .select(conversationSelection())
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.id),
          eq(conversations.orgId, orgId),
          eq(conversations.userId, userId),
        ),
      )
      .limit(1)

    if (existing) {
      if (
        input.workspaceId &&
        existing.workspaceId &&
        existing.workspaceId !== input.workspaceId
      ) {
        throw createError({
          message: "Conversation not found",
          status: 404,
          why: "Conversation does not belong to this Workspace",
        })
      }
      return existing
    }

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
        workspaceId: input.workspaceId ?? null,
        source: input.source ?? null,
        name: "New conversation",
      })
      .returning()

    if (!created) throw new Error("Failed to create conversation")
    return created
  })
}

export async function persistConversationPublication(input: {
  conversationId: string
  lastChatPrNumber?: number
  lastBranch: string
  revision: WorkspaceRevision
}): Promise<boolean> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    const db = getOrgDb()
    const [binding] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(sql`${workspaces.id} = ${input.revision.workspaceId}
              and ${workspaces.orgId} = ${orgId}
              and ${workspaces.desiredGeneration} = ${input.revision.generation}
              and ${workspaces.workspaceRepositoryUrl} = ${input.revision.remote.url}
              and ${workspaces.githubConnectionId} is not distinct from ${input.revision.remote.connectionId}
              and ${workspaces.desiredDefaultBranch} = ${input.revision.defaultBranch}
              and ${workspaces.desiredSha} = ${input.revision.sha}`)
      .for("update")
    if (!binding) return false
    const [row] = await db
      .update(conversations)
      .set({
        lastChatPrNumber: input.lastChatPrNumber,
        lastChatPrRevision:
          input.lastChatPrNumber === undefined ? undefined : input.revision,
        lastBranch: input.lastBranch,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.orgId, orgId),
          eq(conversations.userId, userId),
          eq(conversations.workspaceId, input.revision.workspaceId),
        ),
      )
      .returning({ id: conversations.id })
    return row != null
  })
}

export async function listOrgConversationsForSandboxGc(
  orgId: string = requireCurrentOrgId(),
): Promise<
  Array<{
    id: string
    workspaceId: string | null
    lastMessageAt: Date | null
  }>
> {
  return orgSql(async () => {
    return getOrgDb()
      .select({
        id: conversations.id,
        workspaceId: conversations.workspaceId,
        lastMessageAt: conversations.lastMessageAt,
      })
      .from(conversations)
      .where(eq(conversations.orgId, orgId))
  })
}

export async function persistConversationLastBranch(input: {
  conversationId: string
  lastBranch: string | null
}): Promise<void> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    await getOrgDb()
      .update(conversations)
      .set({
        lastBranch: input.lastBranch,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.orgId, orgId),
          eq(conversations.userId, userId),
        ),
      )
  })
}

export async function touchConversationLastMessage(
  conversationId: string,
): Promise<void> {
  return orgSql(async () => {
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
  })
}

/** Removes a compose row that never recorded a successful turn. */
export async function discardUnstartedConversation(
  conversationId: string,
): Promise<void> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    const db = getOrgDb()
    await db
      .delete(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.orgId, orgId),
          eq(conversations.userId, userId),
          isNull(conversations.lastMessageAt),
        ),
      )
  })
}

export async function listConversations(input?: {
  source?: string
  workspaceId?: string
}): Promise<ConversationRecord[]> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    const db = getOrgDb()
    const conditions = [
      eq(conversations.orgId, orgId),
      eq(conversations.userId, userId),
      isNotNull(conversations.lastMessageAt),
      input?.source ? eq(conversations.source, input.source) : null,
      input?.workspaceId
        ? eq(conversations.workspaceId, input.workspaceId)
        : null,
    ].filter(Boolean) as ReturnType<typeof eq>[]

    return db
      .select(conversationSelection())
      .from(conversations)
      .where(and(...conditions))
      .orderBy(
        sql`${conversations.lastMessageAt} DESC NULLS LAST`,
        desc(conversations.id),
      )
  })
}

export async function listConversationsPaginated(input: {
  source?: string
  workspaceId?: string
  first: number
  after?: string
}): Promise<{ items: ConversationRecord[]; pageInfo: PageInfo }> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    const db = getOrgDb()
    const { first, after } = input

    const baseConditions = [
      eq(conversations.orgId, orgId),
      eq(conversations.userId, userId),
      isNotNull(conversations.lastMessageAt),
      input.source ? eq(conversations.source, input.source) : null,
      input.workspaceId
        ? eq(conversations.workspaceId, input.workspaceId)
        : null,
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

    if (cursor?.lastMessageAt) {
      const cursorLastMessageAt = new Date(cursor.lastMessageAt)
      cursorCondition = or(
        lt(conversations.lastMessageAt, cursorLastMessageAt),
        and(
          eq(conversations.lastMessageAt, cursorLastMessageAt),
          lt(conversations.id, cursor.id),
        ),
      )
    }

    const whereClause =
      cursorCondition !== null
        ? and(...baseConditions, cursorCondition)
        : and(...baseConditions)

    const rows = await db
      .select(conversationSelection())
      .from(conversations)
      .where(whereClause)
      .orderBy(
        sql`${conversations.lastMessageAt} DESC NULLS LAST`,
        desc(conversations.id),
      )
      .limit(first + 1)

    return buildPageInfo({
      items: rows,
      limit: first,
      after,
      encodeCursor: encodeConversationCursor,
    })
  })
}

export async function getConversation(
  conversationId: string,
  input?: { workspaceId?: string },
): Promise<ConversationRecord | null> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const userId = requireCurrentUserId()
    const db = getOrgDb()
    const [row] = await db
      .select(conversationSelection())
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.orgId, orgId),
          eq(conversations.userId, userId),
        ),
      )
      .limit(1)
    if (!row) return null
    if (input?.workspaceId && row.workspaceId !== input.workspaceId) {
      return null
    }
    return row
  })
}

/** Org + workspace existence check. Not an ACL — callers already authorized. */
export async function findConversationInWorkspace(
  conversationId: string,
  workspaceId: string,
): Promise<ConversationRecord | null> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const [row] = await db
      .select(conversationSelection())
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.orgId, orgId),
          eq(conversations.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    return row ?? null
  })
}

export async function updateConversation(
  conversationId: string,
  input: { name: string },
): Promise<ConversationRecord | null> {
  return orgSql(async () => {
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
      .returning(conversationSelection())
    return updated ?? null
  })
}

export async function deleteConversation(
  conversationId: string,
): Promise<boolean> {
  return orgSql(async () => {
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
  })
}
