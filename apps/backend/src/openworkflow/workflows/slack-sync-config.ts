import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getSlackConnectionByConnectionId,
  getSlackSyncTargetByConnectionId,
  markSlackSyncTargetLive,
  updateSlackSyncTargetPrState,
} from "../../models/slack-connector.js"
import { getLogger } from "../../observability/logger.js"
import { syncSlackConfigYaml } from "../../services/slack/sync.js"

const slackSyncConfigInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
})

export const slackSyncConfig = defineWorkflow(
  {
    name: "slack-sync-config",
    schema: slackSyncConfigInputSchema,
  },
  async ({ input }) => {
    const target = await getSlackSyncTargetByConnectionId(input.connectionId)
    if (!target) throw new Error("Slack sync target is not configured")
    if (target.orgId !== input.orgId) {
      throw new Error("Slack sync target does not belong to organization")
    }

    try {
      const connection = await withOrgDbContext(input.orgId, () =>
        getSlackConnectionByConnectionId(input.orgId, input.connectionId),
      )
      if (!connection) throw new Error("Slack connection not found")

      const result = await syncSlackConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env: parseEnv(process.env as Record<string, string | undefined>),
        connection,
        target,
      })
      if (!result.changed) {
        // Config already matches the repo (e.g. PR merged out-of-band, or
        // re-save with identical scope). If we are not live yet, start content
        // sync instead of skipping straight to live with an empty mirror.
        if (target.setupPhase !== "live") {
          const { enqueueSlackFullSyncAfterConfigPush } = await import(
            "../enqueue-slack-push-sync.js"
          )
          await enqueueSlackFullSyncAfterConfigPush({
            orgId: input.orgId,
            connectionId: input.connectionId,
            log: {
              error: (err) =>
                getLogger().error(err, {
                  step: "slack_sync_config.enqueue_content",
                  connectionId: input.connectionId,
                }),
            },
          })
        } else {
          await withOrgDbContext(input.orgId, () =>
            markSlackSyncTargetLive({ connectionId: input.connectionId }),
          )
        }
      } else {
        await withOrgDbContext(input.orgId, () =>
          updateSlackSyncTargetPrState({
            connectionId: input.connectionId,
            pendingConfigPullUrl: result.pullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: "awaiting_merge",
          }),
        )
      }
      return result
    } catch (e) {
      const currentTarget = await getSlackSyncTargetByConnectionId(
        input.connectionId,
      )
      if (currentTarget && currentTarget.setupPhase !== "sync_failed") {
        await withOrgDbContext(input.orgId, () =>
          updateSlackSyncTargetPrState({
            connectionId: input.connectionId,
            pendingConfigPullUrl: target.pendingConfigPullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: target.setupPhase,
          }),
        )
      }
      throw e
    }
  },
)
