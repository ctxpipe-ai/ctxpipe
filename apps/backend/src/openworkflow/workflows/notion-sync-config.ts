import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getNotionSyncTargetByConnectionId,
  listNotionResourcesByConnectionId,
  markNotionSyncTargetLive,
  updateNotionSyncTargetPrState,
} from "../../models/notion-connector.js"
import { syncNotionConfigYaml } from "../../services/notion/sync.js"

const notionSyncConfigInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
})

export const notionSyncConfig = defineWorkflow(
  { name: "notion-sync-config", schema: notionSyncConfigInputSchema },
  async ({ input, step }) => {
    const target = await step.run({ name: "load-sync-target" }, () =>
      getNotionSyncTargetByConnectionId(input.connectionId),
    )
    if (!target) throw new Error("Notion sync target is not configured")
    if (target.orgId !== input.orgId) {
      throw new Error("Notion sync target does not belong to organization")
    }

    try {
      const resources = await step.run({ name: "load-resources" }, () =>
        withOrgDbContext(input.orgId, () =>
          listNotionResourcesByConnectionId(input.connectionId),
        ),
      )
      const result = await step.run({ name: "sync-config" }, () =>
        syncNotionConfigYaml({
          orgId: input.orgId,
          orgSlug: input.orgSlug,
          env: parseEnv(process.env as Record<string, string | undefined>),
          connectionId: input.connectionId,
          target,
          resources,
        }),
      )
      await step.run({ name: "persist-config-pr-state" }, () =>
        withOrgDbContext(input.orgId, () =>
          result.changed
            ? updateNotionSyncTargetPrState({
                connectionId: input.connectionId,
                pendingConfigPullUrl: result.pullUrl ?? null,
                pendingConfigPrCreating: false,
                setupPhase: "awaiting_merge",
              })
            : markNotionSyncTargetLive({ connectionId: input.connectionId }),
        ),
      )
      return result
    } catch (e) {
      await step.run({ name: "clear-config-pr-claim" }, () =>
        withOrgDbContext(input.orgId, () =>
          updateNotionSyncTargetPrState({
            connectionId: input.connectionId,
            pendingConfigPullUrl: target.pendingConfigPullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: target.setupPhase,
          }),
        ),
      )
      throw e
    }
  },
)
