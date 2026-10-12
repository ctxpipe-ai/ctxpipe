import { and, eq, like } from "drizzle-orm"
import { type Db, withOrgDbContext } from "../db/client.js"
import { chatMetadata } from "../db/schema/chat-persistence.js"
import { maskCredentialsDeep } from "../domain/workspaces/mask-credentials.js"

/**
 * One Sync of a conversation: the user pushed its commits to the session
 * branch. The thread shows it after the last user turn at that time. Rows
 * live in the chat metadata table (namespace below, key
 * `<conversationId>:<sha>`), so no new table is necessary. The record is not
 * a message, so the model never sees it.
 */
export type ConversationSync = {
  branch: string
  sha: string
  /** The number of files that the pushed commits changed. */
  files: number
  treeUrl: string
  /** The number of user messages in the thread at the time of the Sync. */
  turn: number
  syncedAt: string
}

const NAMESPACE = "ctxpipe.conversation-syncs"

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export async function saveConversationSync(input: {
  orgId: string
  conversationId: string
  sync: ConversationSync
}): Promise<void> {
  const sync = maskCredentialsDeep(input.sync)
  await withOrgDbContext(input.orgId, (db) =>
    db
      .insert(chatMetadata)
      .values({
        namespace: NAMESPACE,
        key: `${input.conversationId}:${sync.sha}`,
        orgId: input.orgId,
        valueJson: sync,
      })
      .onConflictDoUpdate({
        target: [chatMetadata.namespace, chatMetadata.key],
        set: { valueJson: sync },
      }),
  )
}

/** The conversation's syncs, oldest first. */
export async function listConversationSyncs(input: {
  orgId: string
  conversationId: string
}): Promise<ConversationSync[]> {
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
    .map((row) => row.valueJson as ConversationSync)
    .sort((a, b) => a.syncedAt.localeCompare(b.syncedAt))
}

/** Runs inside the caller's org transaction when the conversation goes. */
export async function deleteConversationSyncs(
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
