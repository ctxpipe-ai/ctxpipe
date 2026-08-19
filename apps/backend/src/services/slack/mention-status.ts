import type { Env } from "../../config/env.js"
import type { SlackConnectionShape } from "../../models/connection-rows.js"
import { getLogger } from "../../observability/logger.js"
import { postSlackThreadMessage, updateSlackMessage } from "./client.js"

/** Posted when the mention agent cannot be enqueued. */
export const SLACK_MENTION_STATUS_ENQUEUE_FAILED =
  "Engineering context capture failed. Could not start the capture job. Mention the bot again."

/**
 * Prefer `chat.update` of the working status message. If that message was
 * never posted or update fails, post a new thread reply so the thread never
 * stays on “working…” and never goes silent.
 */
export async function publishSlackMentionStatus(input: {
  env: Env
  connection: SlackConnectionShape
  channelId: string
  threadTs: string
  text: string
  messageTs?: string | null
}): Promise<boolean> {
  if (input.messageTs) {
    const updated = await updateSlackMessage({
      env: input.env,
      connection: input.connection,
      channelId: input.channelId,
      messageTs: input.messageTs,
      text: input.text,
    })
    if (updated) return true
    getLogger().warn("slack_mention_status_update_failed", {
      channelId: input.channelId,
      threadTs: input.threadTs,
      statusMessageTs: input.messageTs,
    })
  }

  const posted = await postSlackThreadMessage({
    env: input.env,
    connection: input.connection,
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: input.text,
  })
  if (posted) return true

  getLogger().warn("slack_mention_status_publish_failed", {
    channelId: input.channelId,
    threadTs: input.threadTs,
    statusMessageTs: input.messageTs ?? undefined,
  })
  return false
}
