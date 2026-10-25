import { eq } from "drizzle-orm"

import { getOrgDb } from "../db/client.js"
import { withAmbientOrgDb } from "../db/org-sql.js"
import { conversationMessages } from "../db/schema/conversations.js"

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

type ConversationTurn = {
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
