import { z } from "zod"

/**
 * The webhook event that the Slack source sync gets: one thread of one
 * channel changed (ADR-050). A message that is not in a thread is not
 * mirrored, so it gives no event.
 */
export type SlackSourceEvent = { channelId: string; threadTs: string }

const slackTs = z.string().regex(/^\d+\.\d+$/)

const sourceEventSchema = z.object({
  channelId: z.string().min(1),
  threadTs: slackTs,
})

const messageEventSchema = z.object({
  type: z.literal("message"),
  channel: z.string().min(1),
  channel_type: z.enum(["channel", "group"]),
  user: z.string().optional(),
  thread_ts: slackTs.optional(),
  message: z
    .object({ thread_ts: slackTs.optional(), user: z.string().optional() })
    .optional(),
  previous_message: z.object({ thread_ts: slackTs.optional() }).optional(),
})

/**
 * Read the source event from a Slack `message` event, or null when the
 * event does not change a thread of a channel: a direct message, a message
 * without a thread, or a message that the connection's own bot posted.
 */
export function slackSourceEventFromMessage(
  event: unknown,
  botUserId: string | null,
): SlackSourceEvent | null {
  const parsed = messageEventSchema.safeParse(event)
  if (!parsed.success) return null
  const message = parsed.data
  const author = message.user ?? message.message?.user
  if (botUserId && author === botUserId) return null
  const threadTs =
    message.thread_ts ??
    message.message?.thread_ts ??
    message.previous_message?.thread_ts
  return threadTs ? { channelId: message.channel, threadTs } : null
}

export function parseSlackSourceEvent(event: unknown): SlackSourceEvent | null {
  const parsed = sourceEventSchema.safeParse(event)
  return parsed.success ? parsed.data : null
}

/** Whether a source event touches a scope. An unknown event touches each scope. */
export function slackEventMatches(
  event: unknown,
  scope: { channels: readonly string[] },
): boolean {
  const parsed = parseSlackSourceEvent(event)
  return !parsed || scope.channels.includes(parsed.channelId)
}
