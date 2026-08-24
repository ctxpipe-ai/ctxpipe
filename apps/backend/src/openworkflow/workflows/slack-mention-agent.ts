import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getSlackConnectionByConnectionId,
  getSlackSyncTargetByConnectionId,
} from "../../models/slack-connector.js"
import { getLogger } from "../../observability/logger.js"
import {
  postSlackThreadMessage,
  SLACK_CAPTURE_STATUS_FAILED,
  SLACK_MENTION_STATUS_WORKING,
} from "../../services/slack/client.js"
import {
  formatSlackMentionStatusText,
  runSlackMentionAgent,
  type SlackMentionAgentResult,
} from "../../services/slack/mention-agent.js"
import { publishSlackMentionStatus } from "../../services/slack/mention-status.js"

const slackMentionAgentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  mentionText: z.string().optional(),
  mentionUserId: z.string().optional(),
})

export const slackMentionAgent = defineWorkflow(
  {
    name: "slack-mention-agent",
    schema: slackMentionAgentInputSchema,
  },
  async ({ input }) => {
    const target = await getSlackSyncTargetByConnectionId(input.connectionId)
    if (!target) throw new Error("Slack sync target is not configured")
    if (target.orgId !== input.orgId) {
      throw new Error("Slack sync target does not belong to organization")
    }
    if (!target.enabled) {
      throw new Error("Slack connector is not live for this connection")
    }

    const connection = await withOrgDbContext(input.orgId, () =>
      getSlackConnectionByConnectionId(input.orgId, input.connectionId),
    )
    if (!connection) throw new Error("Slack connection not found")

    const env = parseEnv(process.env as Record<string, string | undefined>)

    const statusMessage = await postSlackThreadMessage({
      env,
      connection,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: SLACK_MENTION_STATUS_WORKING,
    })

    let outcome: SlackMentionAgentResult = {
      kind: "failed",
      error: SLACK_CAPTURE_STATUS_FAILED,
    }
    try {
      outcome = await runSlackMentionAgent({
        orgId: input.orgId,
        env,
        connection,
        target,
        channelId: input.channelId,
        threadTs: input.threadTs,
        mentionText: input.mentionText,
        mentionUserId: input.mentionUserId,
        excludeMessageTs: statusMessage?.ts,
      })
    } catch (error) {
      outcome = {
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
      }
      throw error
    } finally {
      await publishSlackMentionStatus({
        env,
        connection,
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: formatSlackMentionStatusText(outcome),
        messageTs: statusMessage?.ts,
      })
    }

    if (outcome.kind === "failed") {
      throw new Error(outcome.error ?? "Slack mention agent failed")
    }
    if (outcome.kind === "captured") {
      const { runRepositoryIngestionWorkflow } = await import(
        "../enqueue-repository-ingestion.js"
      )
      await runRepositoryIngestionWorkflow(
        {
          repositoryId: target.repositoryId,
          orgId: input.orgId,
          targetBranch: target.branch,
          indexingReason: "Applying Slack capture",
        },
        {
          error: (error) =>
            getLogger().error(error, {
              step: "slack-mention-agent.ingestion",
              connectionId: input.connectionId,
            }),
        },
      )
    }
    return outcome
  },
)
