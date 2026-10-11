import { and, eq, like } from "drizzle-orm"
import { type Db, withOrgDbContext } from "../db/client.js"
import { chatMetadata } from "../db/schema/chat-persistence.js"
import type { ConversationTurnFile } from "../domain/workspaces/conversation-turn-changes.js"

/**
 * The files one chat turn changed. Rows live in the chat metadata table
 * (namespace below, key `<conversationId>:<runId>`), so no new table is
 * necessary. `turn` is the number of user messages in the thread at the end
 * of the turn: the UI shows the card after the reply to that user message.
 */
export type ConversationTurnChanges = {
  runId: string
  turn: number
  startTree: string
  endTree: string
  finishedAt: number
  files: ConversationTurnFile[]
}

const NAMESPACE = "ctxpipe.conversation-turn-changes"

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export async function saveConversationTurnChanges(input: {
  orgId: string
  conversationId: string
  changes: ConversationTurnChanges
}): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .insert(chatMetadata)
      .values({
        namespace: NAMESPACE,
        key: `${input.conversationId}:${input.changes.runId}`,
        orgId: input.orgId,
        valueJson: input.changes,
      })
      .onConflictDoUpdate({
        target: [chatMetadata.namespace, chatMetadata.key],
        set: { valueJson: input.changes },
      }),
  )
}

export async function listConversationTurnChanges(input: {
  orgId: string
  conversationId: string
}): Promise<ConversationTurnChanges[]> {
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({ valueJson: chatMetadata.valueJson })
      .from(chatMetadata)
      .where(
        and(
          eq(chatMetadata.namespace, NAMESPACE),
          eq(chatMetadata.orgId, input.orgId),
          like(chatMetadata.key, `${escapeLike(input.conversationId)}:%`),
        ),
      ),
  )
  return rows
    .map((row) => row.valueJson as ConversationTurnChanges)
    .sort((a, b) => a.turn - b.turn || a.finishedAt - b.finishedAt)
}

/** Runs inside the caller's org transaction when the conversation goes. */
export async function deleteConversationTurnChanges(
  db: Db,
  conversationId: string,
): Promise<void> {
  await db
    .delete(chatMetadata)
    .where(
      and(
        eq(chatMetadata.namespace, NAMESPACE),
        like(chatMetadata.key, `${escapeLike(conversationId)}:%`),
      ),
    )
}
