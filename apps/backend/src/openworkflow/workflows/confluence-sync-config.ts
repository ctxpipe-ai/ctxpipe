import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getConfluenceSyncTargetByConnectionId,
  updateConfluenceSyncTargetPrState,
} from "../../models/confluence-sync-target.js"
import { captureConnectorConfigSyncBinding } from "../../models/connector-content-sync.js"
import { syncConfluenceConfigYaml } from "../../services/confluence/sync.js"
import { enqueueConnectorContentSync } from "../enqueue-connector-content-sync.js"

const confluenceSyncConfigInputSchema = z.object({
  contentSyncGeneration: z.number().int().nonnegative().default(0),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
})

export const confluenceSyncConfig = defineWorkflow(
  {
    name: "confluence-sync-config",
    schema: confluenceSyncConfigInputSchema,
  },
  async ({ input, step, run }) => {
    if (
      !(await step.run({ name: "capture-config-binding" }, () =>
        captureConnectorConfigSyncBinding({
          orgId: input.orgId,
          connectionId: input.connectionId,
          contentSyncGeneration: input.contentSyncGeneration ?? 0,
        }),
      ))
    )
      throw new Error("Connector configuration activation was superseded")
    const target = await step.run({ name: "load-confluence-binding" }, () =>
      getConfluenceSyncTargetByConnectionId(input.connectionId),
    )
    if (
      !target ||
      target.orgId !== input.orgId ||
      !target.enabled ||
      target.setupPhase !== "awaiting_merge" ||
      !target.pendingConfigPrCreating
    )
      throw new Error(
        "Confluence sync target is not ready for configuration sync",
      )
    const result = await step.run({ name: "sync-config" }, () =>
      syncConfluenceConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env: parseEnv(process.env),
        connectionId: input.connectionId,
        target,
      }),
    )
    if (result.changed) {
      await step.run({ name: "persist-config-pr-state" }, () =>
        withOrgDbContext(input.orgId, () =>
          updateConfluenceSyncTargetPrState({
            connectionId: input.connectionId,
            pendingConfigPullUrl: result.pullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: "awaiting_merge",
            expectedBinding: {
              repositoryId: target.repositoryId,
              branch: target.branch,
            },
          }),
        ),
      )
    } else {
      await step.run({ name: "enqueue-initial-content-sync" }, async () => {
        if (
          !(await enqueueConnectorContentSync({
            orgId: input.orgId,
            orgSlug: input.orgSlug,
            connectionId: input.connectionId,
            provider: "confluence",
            repositoryId: target.repositoryId,
            branch: target.branch,
            configKey: `config-workflow:${run.id}`,
          }))
        )
          throw new Error(
            "Confluence sync target changed during configuration sync",
          )
      })
    }
    return result
  },
)
