import { eq, max } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { conversationMessages } from "../db/schema/conversations.js"
import { generateObjectId } from "../lib/id.js"
import { withAmbientOrgDb } from "../db/org-sql.js"

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

export type ConversationTurn = {
  role: "user" | "assistant"
  content: string
}

export async function loadConversationTurns(
  conversationId: string,
): Promise<ConversationTurn[]> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(conversationMessages.seq)
    return rows.flatMap((row) => {
      if (row.role !== "user" && row.role !== "assistant") return []
      return [{ role: row.role, content: row.content }]
    })
  })
}

export async function appendConversationTurn(input: {
  conversationId: string
  role: "user" | "assistant"
  content: string
  orgId?: string
}): Promise<void> {
  return orgSql(async () => {
    const db = getOrgDb()
    const orgId = input.orgId ?? requireCurrentOrgId()
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ seq: max(conversationMessages.seq) })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, input.conversationId))
      const seq = (row?.seq ?? 0) + 1
      await tx.insert(conversationMessages).values({
        id: generateObjectId("cmsg"),
        conversationId: input.conversationId,
        orgId,
        role: input.role,
        content: input.content,
        seq,
      })
    })
  })
}
