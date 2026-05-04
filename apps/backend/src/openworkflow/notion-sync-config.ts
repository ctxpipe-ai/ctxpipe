import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import {
  getNotionSyncTargetByConnectionId,
  listNotionResourcesByConnectionId,
  markNotionSyncTargetLive,
  updateNotionSyncTargetPrState,
} from "../models/notion-connector.js"
import { syncNotionConfigYaml } from "../services/notion/sync.js"

const notionSyncConfigInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
})

export const notionSyncConfig = defineWorkflow(
  { name: "notion-sync-config", schema: notionSyncConfigInputSchema },
  async ({ input }) => {
    const target = await getNotionSyncTargetByConnectionId(input.connectionId)
    if (!target) throw new Error("Notion sync target is not configured")
    if (target.orgId !== input.orgId) {
      throw new Error("Notion sync target does not belong to organization")
    }

    try {
      const resources = await withOrgDbContext(input.orgId, () =>
        listNotionResourcesByConnectionId(input.connectionId),
      )
      const result = await syncNotionConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env: parseEnv(process.env as Record<string, string | undefined>),
        connectionId: input.connectionId,
        target,
        resources,
      })
      if (!result.changed) {
        await withOrgDbContext(input.orgId, () =>
          markNotionSyncTargetLive({ connectionId: input.connectionId }),
        )
      } else {
        await withOrgDbContext(input.orgId, () =>
          updateNotionSyncTargetPrState({
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
        updateNotionSyncTargetPrState({
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
