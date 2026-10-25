import { and, eq, inArray, like } from "drizzle-orm"

import { type Db, withOrgDbContext } from "../db/client.js"
import { chatMetadata } from "../db/schema/chat-persistence.js"
import type { ChangedFile } from "../domain/workspaces/conversation-diff.js"
import { maskCredentialsDeep } from "../domain/workspaces/mask-credentials.js"

/**
 * Records that the thread shows between its messages. Rows live in the chat
 * metadata table (one namespace per kind, key `<conversationId>:<id>`), so no
 * new table is necessary. They are not messages, so the model never sees
 * them.
 */
const TURN_CHANGES = "ctxpipe.conversation-turn-changes"
const SYNCS = "ctxpipe.conversation-syncs"

/**
 * The files one chat turn changed. The UI places the card after the last
 * message of the run (`runId`). A run with no reply message (a failed turn)
 * has no run id on a message; `turn`, the number of user messages at the end
 * of the turn, then places the card after that user message.
 */
export type ConversationTurnChanges = {
  runId: string
  turn: number
  startTree: string
  endTree: string
  finishedAt: number
  files: ChangedFile[]
}

/**
 * What pushed the conversation's commits: the user's Sync, the user's Create
 * PR, the agent's push tool, or the push before the sweep deletes the
 * sandbox.
 */
export type ConversationPushTrigger = "sync" | "create_pr" | "agent" | "sweep"

/**
 * One push of the conversation's commits to its session branch. The thread
 * shows it after the last message of user turn `turn`.
 */
export type ConversationSync = {
  trigger: ConversationPushTrigger
  /** Create PR: the pull request; `opened` when this push opened it. */
  pullRequest?: { number: number; url: string; opened: boolean }
  branch: string
  sha: string
  /** The number of files that the pushed commits changed. */
  files: number
  treeUrl: string
  /** The number of user messages in the thread at the time of the Sync. */
  turn: number
  syncedAt: string
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

async function listRecords(
  namespace: string,
  input: { orgId: string; conversationId: string },
): Promise<unknown[]> {
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({ valueJson: chatMetadata.valueJson })
      .from(chatMetadata)
      .where(
        and(
          eq(chatMetadata.namespace, namespace),
          eq(chatMetadata.orgId, input.orgId),
          like(chatMetadata.key, `${escapeLike(input.conversationId)}:%`),
        ),
      ),
  )
  return rows.map((row) => row.valueJson)
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
        namespace: TURN_CHANGES,
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
  return (
    (await listRecords(TURN_CHANGES, input)) as ConversationTurnChanges[]
  ).sort((a, b) => a.turn - b.turn || a.finishedAt - b.finishedAt)
}

/**
 * A commit that was already pushed keeps its first entry: a second push of
 * the same commit (for example, after the branch was deleted on GitHub) does
 * not move it in the history.
 */
export async function saveConversationSync(input: {
  orgId: string
  conversationId: string
  sync: ConversationSync
}): Promise<void> {
  // The tree URL comes from the remote URL, which can hold a credential.
  const sync = maskCredentialsDeep(input.sync)
  await withOrgDbContext(input.orgId, (db) =>
    db
      .insert(chatMetadata)
      .values({
        namespace: SYNCS,
        key: `${input.conversationId}:${sync.sha}`,
        orgId: input.orgId,
        valueJson: sync,
      })
      .onConflictDoNothing({
        target: [chatMetadata.namespace, chatMetadata.key],
      }),
  )
}

/** The conversation's syncs, oldest first. */
export async function listConversationSyncs(input: {
  orgId: string
  conversationId: string
}): Promise<ConversationSync[]> {
  return ((await listRecords(SYNCS, input)) as ConversationSync[])
    .map((sync) => ({ ...sync, trigger: sync.trigger ?? "sync" }))
    .sort((a, b) => a.syncedAt.localeCompare(b.syncedAt))
}

/**
 * Deletes the conversation's turn changes and syncs. Runs inside the caller's
 * org transaction when the conversation goes.
 */
export async function deleteConversationThreadRecords(
  db: Db,
  conversationId: string,
): Promise<void> {
  await db
    .delete(chatMetadata)
    .where(
      and(
        inArray(chatMetadata.namespace, [TURN_CHANGES, SYNCS]),
        like(chatMetadata.key, `${escapeLike(conversationId)}:%`),
      ),
    )
}
