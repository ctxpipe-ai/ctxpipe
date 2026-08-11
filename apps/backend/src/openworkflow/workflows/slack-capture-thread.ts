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
  SLACK_CAPTURE_STATUS_CAPTURED,
  SLACK_CAPTURE_STATUS_CAPTURING,
  SLACK_CAPTURE_STATUS_FAILED,
  updateSlackMessage,
} from "../../services/slack/client.js"
import { captureSlackThread } from "../../services/slack/sync.js"

const slackCaptureThreadInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
})

export const slackCaptureThread = defineWorkflow(
  {
    name: "slack-capture-thread",
    schema: slackCaptureThreadInputSchema,
  },
  async ({ input }) => {
    const target = await getSlackSyncTargetByConnectionId(input.connectionId)
    if (!target) throw new Error("Slack sync target is not configured")
    if (target.orgId !== input.orgId) {
      throw new Error("Slack sync target does not belong to organization")
    }
    if (!target.enabled || target.setupPhase !== "live") {
      throw new Error("Slack connector is not live for this connection")
    }

    const connection = await withOrgDbContext(input.orgId, () =>
      getSlackConnectionByConnectionId(input.orgId, input.connectionId),
    )
    if (!connection) throw new Error("Slack connection not found")

    const env = parseEnv(process.env as Record<string, string | undefined>)

    // Progress feedback in-thread: capturing → captured|failed (chat.update).
    // Soft-fail: capture still runs if the status post cannot be created.
    const statusMessage = await postSlackThreadMessage({
      env,
      connection,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: SLACK_CAPTURE_STATUS_CAPTURING,
    })

    const result = await captureSlackThread({
      orgId: input.orgId,
      env,
      connection,
      target,
      channelId: input.channelId,
      threadTs: input.threadTs,
      excludeMessageTs: statusMessage?.ts,
    })

    if (statusMessage) {
      // Short confirmation + Slack mrkdwn link — avoid dumping the repo path.
      const text =
        result.status === "completed"
          ? result.githubUrl
            ? `${SLACK_CAPTURE_STATUS_CAPTURED} <${result.githubUrl}|View in GitHub>`
            : SLACK_CAPTURE_STATUS_CAPTURED
          : SLACK_CAPTURE_STATUS_FAILED
      const updated = await updateSlackMessage({
        env,
        connection,
        channelId: input.channelId,
        messageTs: statusMessage.ts,
        text,
      })
      if (!updated) {
        getLogger().warn("slack_capture_status_update_failed", {
          connectionId: input.connectionId,
          channelId: input.channelId,
          threadTs: input.threadTs,
          statusMessageTs: statusMessage.ts,
        })
      }
    }

    if (result.status === "failed") {
      throw new Error(result.error ?? "Slack thread capture failed")
    }

    return result
  },
)
