import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  finalizeSlackSyncTargetAfterContentWorkflow,
  getSlackConnectionByConnectionId,
  getSlackSyncTargetByConnectionId,
} from "../../models/slack-connector.js"
import { syncSlackContent } from "../../services/slack/sync.js"

const slackSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
})

export const slackSyncContent = defineWorkflow(
  {
    name: "slack-sync-content",
    schema: slackSyncContentInputSchema,
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

    const result = await syncSlackContent({
      orgId: input.orgId,
      env: parseEnv(process.env as Record<string, string | undefined>),
      connection,
      target,
    })

    await finalizeSlackSyncTargetAfterContentWorkflow({
      connectionId: input.connectionId,
      workflowStatus: result.status,
    })

    return result
  },
)
