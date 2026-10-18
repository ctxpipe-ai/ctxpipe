import { z } from "zod"
import type { SourceScopeDefinition } from "./scope.js"

/**
 * A Slack public (`C…`) or private (`G…`) channel id. Direct messages are
 * not sources (ADR-025). The id is also a path segment, so it holds only
 * capital letters and digits.
 */
export const SLACK_CHANNEL_ID_PATTERN = "[CG][A-Z0-9]{2,31}"

const slackChannelId = z
  .string()
  .regex(
    new RegExp(`^${SLACK_CHANNEL_ID_PATTERN}$`),
    "Use a Slack channel id, for example C0123ABCD",
  )

export const slackScopeSchema = z.object({
  /** The channel ids of the source. Names change; ids stay. */
  channels: z
    .array(slackChannelId)
    .min(1, "Select at least one channel")
    .max(100, "Select at most 100 channels for one source")
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Each channel must occur one time",
    }),
})

export type SlackSourceScope = z.infer<typeof slackScopeSchema>

export function summarizeSlackScope(scope: SlackSourceScope): string {
  const n = scope.channels.length
  return `${n} Slack ${n === 1 ? "channel" : "channels"}`
}

/** The Slack source scope: a set of channels of the Slack team. */
export const slackSourceScope: SourceScopeDefinition = {
  connectionType: "slack",
  label: "Slack",
  schema: slackScopeSchema,
  // The frame calls summarize only with a scope that the schema accepted.
  summarize: (scope) => summarizeSlackScope(scope as SlackSourceScope),
}
