import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  finalizeSlackSyncTargetAfterContentWorkflow,
  getSlackConnectionByConnectionId,
  getSlackSyncTargetByConnectionId,
  markSlackSyncTargetFailed,
  markSlackSyncTargetInitialSync,
} from "../../models/slack-connector.js"
import { getLogger } from "../../observability/logger.js"
import { SlackApiError } from "../../services/slack/client.js"
import { syncSlackContent } from "../../services/slack/sync.js"

const slackSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
})

const MAX_CONTENT_ATTEMPTS = 4

function isSleepSignal(error: unknown): boolean {
  return error instanceof Error && error.name === "SleepSignal"
}

export const slackSyncContent = defineWorkflow(
  {
    name: "slack-sync-content",
    schema: slackSyncContentInputSchema,
  },
  async ({ input, step }) => {
    let targetValidated = false
    try {
      const target = await getSlackSyncTargetByConnectionId(input.connectionId)
      if (!target) throw new Error("Slack sync target is not configured")
      if (target.orgId !== input.orgId) {
        throw new Error("Slack sync target does not belong to organization")
      }
      targetValidated = true

      await withOrgDbContext(input.orgId, () =>
        markSlackSyncTargetInitialSync({ connectionId: input.connectionId }),
      )

      const connection = await withOrgDbContext(input.orgId, () =>
        getSlackConnectionByConnectionId(input.orgId, input.connectionId),
      )
      if (!connection) throw new Error("Slack connection not found")

      const env = parseEnv(process.env as Record<string, string | undefined>)
      let last = await step.run({ name: "sync-0" }, () =>
        syncSlackContent({
          orgId: input.orgId,
          env,
          connection,
          target,
        }),
      )

      for (let i = 1; i < MAX_CONTENT_ATTEMPTS; i++) {
        const rateLimited = last.errors.some((error) =>
          error.message.includes("ratelimited"),
        )
        if (last.status !== "failed" || !rateLimited) break

        await step.sleep(`wait-rate-limit-${i}`, "60s")
        last = await step.run({ name: `sync-${i}` }, () =>
          syncSlackContent({
            orgId: input.orgId,
            env,
            connection,
            target,
          }),
        )
      }

      // Surface hard rate-limit exhaustion so OpenWorkflow can retry the run.
      if (
        last.status === "failed" &&
        last.errors.some((error) => error.message.includes("ratelimited"))
      ) {
        throw new SlackApiError({
          slackError: "ratelimited",
          status: 429,
          retryAfterSeconds: 60,
        })
      }

      if (last.status === "partial_failed") {
        throw new Error(
          `Slack initial sync partially failed for ${last.threadsFailed} thread(s)`,
        )
      }
      if (last.status === "failed") {
        throw new Error(
          `Slack initial sync failed for ${last.threadsFailed} thread(s)`,
        )
      }

      await finalizeSlackSyncTargetAfterContentWorkflow({
        connectionId: input.connectionId,
        workflowStatus: last.status,
      })

      return last
    } catch (error) {
      if (isSleepSignal(error)) throw error

      const normalized =
        error instanceof Error ? error : new Error(String(error))
      if (targetValidated) {
        await withOrgDbContext(input.orgId, () =>
          markSlackSyncTargetFailed({ connectionId: input.connectionId }),
        ).catch((markError: unknown) => {
          getLogger().error(
            markError instanceof Error
              ? markError
              : new Error(String(markError)),
            {
              step: "slack-sync-content.mark-failed",
              connectionId: input.connectionId,
              orgId: input.orgId,
            },
          )
        })
      }
      throw normalized
    }
  },
)
