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

/** Cap quiet-wait retries so chatty threads still hit max-lag within ~10 minutes. */
const MAX_FLUSH_ATTEMPTS = 4

export const slackSyncFlush = defineWorkflow(
  {
    name: "slack-sync-flush",
    schema: slackSyncFlushInputSchema,
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
    const flush = async () => {
      const result = await flushSlackDirtyThreads({
        orgId: input.orgId,
        env,
        connection,
        target,
      })
      if (result.status !== "completed") {
        throw new Error(
          `Slack dirty-thread flush ${result.status.replace("_", " ")} for ${result.threadsFailed} thread(s)`,
        )
      }
      return result
    }
    let last = await step.run({ name: "flush-0" }, flush)

    for (let i = 1; i < MAX_FLUSH_ATTEMPTS; i++) {
      if (!last.rescheduleAfterMs || last.rescheduleAfterMs <= 0) {
        return last
      }
      const waitSeconds = Math.min(
        Math.max(Math.ceil(last.rescheduleAfterMs / 1000), 1),
        180,
      )
      await step.sleep(`wait-quiet-${i}`, `${waitSeconds}s`)
      last = await step.run({ name: `flush-${i}` }, flush)
    }

    return last
  },
)
