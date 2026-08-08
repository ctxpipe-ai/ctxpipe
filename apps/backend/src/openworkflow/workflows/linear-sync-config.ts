import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getLinearConnectionByConnectionId,
  getLinearSyncTargetWithRepoByConnectionId,
  listLinearScopesByConnectionId,
  markLinearSyncTargetLive,
  updateLinearSyncTargetPrState,
} from "../../models/linear-connector.js"
import { syncLinearConfigYaml } from "../../services/linear/sync.js"

const LinearSyncConfigInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
})

export const linearSyncConfig = defineWorkflow(
  {
    name: "linear-sync-config",
    schema: LinearSyncConfigInputSchema,
  },
  async ({ input }) => {
    const target = await getLinearSyncTargetWithRepoByConnectionId(
      input.orgId,
      input.connectionId,
    )
    if (!target) throw new Error("Linear sync target is not configured")

    try {
      const env = parseEnv(process.env as Record<string, string | undefined>)
      const [connection, scopes] = await withOrgDbContext(input.orgId, () =>
        Promise.all([
          getLinearConnectionByConnectionId(
            input.orgId,
            input.connectionId,
            env,
          ),
          listLinearScopesByConnectionId(input.connectionId),
        ]),
      )
      if (!connection) throw new Error("Linear connection not found")
      const result = await syncLinearConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env,
        connection,
        target,
        scopes,
      })
      if (result.changed) {
        await withOrgDbContext(input.orgId, () =>
          updateLinearSyncTargetPrState({
            connectionId: input.connectionId,
            pendingConfigPullUrl: result.pullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: "awaiting_merge",
          }),
        )
      } else {
        await withOrgDbContext(input.orgId, () =>
          markLinearSyncTargetLive(input.connectionId),
        )
      }
      return result
    } catch (error) {
      await withOrgDbContext(input.orgId, () =>
        updateLinearSyncTargetPrState({
          connectionId: input.connectionId,
          pendingConfigPullUrl: target.pendingConfigPullUrl,
          pendingConfigPrCreating: false,
          setupPhase: target.setupPhase,
        }),
      )
      throw error
    }
  },
)
