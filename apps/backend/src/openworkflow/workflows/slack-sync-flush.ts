import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getSlackConnectionByConnectionId,
  getSlackSyncTargetByConnectionId,
} from "../../models/slack-connector.js"
import { flushSlackDirtyThreads } from "../../services/slack/sync.js"

const slackSyncFlushInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
})

export const slackSyncFlush = defineWorkflow(
  {
    name: "slack-sync-flush",
    schema: slackSyncFlushInputSchema,
  },
  async ({ input }) => {
    const target = await getSlackSyncTargetByConnectionId(input.connectionId)
    if (!target) throw new Error("Slack sync target is not configured")
    if (target.orgId !== input.orgId) {
      throw new Error("Slack sync target does not belong to organization")
    }

    const connection = await withOrgDbContext(input.orgId, () =>
      getSlackConnectionByConnectionId(input.orgId, input.connectionId),
    )
    if (!connection) throw new Error("Slack connection not found")

    return flushSlackDirtyThreads({
      orgId: input.orgId,
      env: parseEnv(process.env as Record<string, string | undefined>),
      connection,
      target,
    })
  },
)
