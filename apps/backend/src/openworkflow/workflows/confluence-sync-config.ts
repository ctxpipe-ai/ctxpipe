import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getConfluenceSyncTargetByConnectionId,
  markConfluenceSyncTargetInitialSync,
  updateConfluenceSyncTargetPrState,
} from "../../models/confluence-sync-target.js"
import { syncConfluenceConfigYaml } from "../../services/confluence/sync.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { confluenceSyncContent } from "./confluence-sync-content.js"

const confluenceSyncConfigInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
})

export const confluenceSyncConfig = defineWorkflow(
  {
    name: "confluence-sync-config",
    schema: confluenceSyncConfigInputSchema,
    connectorType: "confluence",
  },
  async ({ input }) => {
    const target = await getConfluenceSyncTargetByConnectionId(
      input.connectionId,
    )
    if (!target) {
      throw new Error("Confluence sync target is not configured")
    }
    if (target.orgId !== input.orgId) {
      throw new Error("Confluence sync target does not belong to organization")
    }

    try {
      const result = await syncConfluenceConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env: parseEnv(process.env as Record<string, string | undefined>),
        connectionId: input.connectionId,
        target,
      })
      if (!result.changed) {
        await withOrgDbContext(input.orgId, () =>
          markConfluenceSyncTargetInitialSync({
            connectionId: input.connectionId,
          }),
        )
        await runWorkflowWithWorkerWake(confluenceSyncContent.spec, {
          orgId: input.orgId,
          orgSlug: input.orgSlug,
          connectionId: input.connectionId,
        })
      } else {
        await withOrgDbContext(input.orgId, () =>
          updateConfluenceSyncTargetPrState({
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
        updateConfluenceSyncTargetPrState({
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
