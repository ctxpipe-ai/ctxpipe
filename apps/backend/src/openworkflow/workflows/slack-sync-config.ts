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
        await withOrgDbContext(input.orgId, () =>
          markSlackSyncTargetLive({ connectionId: input.connectionId }),
        )
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
      await withOrgDbContext(input.orgId, () =>
        updateSlackSyncTargetPrState({
          connectionId: input.connectionId,
          pendingConfigPullUrl: target.pendingConfigPullUrl ?? null,
          pendingConfigPrCreating: false,
          setupPhase: target.setupPhase,
        }),
      )
      throw e
    }
  },
)
