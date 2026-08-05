import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  finalizeSlackSyncTargetAfterContentWorkflow,
  getSlackConnectionByConnectionId,
  getSlackSyncTargetByConnectionId,
} from "../../models/slack-connector.js"
import { SlackApiError } from "../../services/slack/client.js"
import { syncSlackContent } from "../../services/slack/sync.js"

const slackSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
})

const MAX_CONTENT_ATTEMPTS = 4

export const slackSyncContent = defineWorkflow(
  {
    name: "slack-sync-content",
    schema: slackSyncContentInputSchema,
  },
  async ({ input, step }) => {
    const target = await getSlackSyncTargetByConnectionId(input.connectionId)
    if (!target) throw new Error("Slack sync target is not configured")
    if (target.orgId !== input.orgId) {
      throw new Error("Slack sync target does not belong to organization")
    }

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

    await finalizeSlackSyncTargetAfterContentWorkflow({
      connectionId: input.connectionId,
      workflowStatus: last.status,
    })

    return last
  },
)
