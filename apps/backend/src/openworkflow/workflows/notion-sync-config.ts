import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { captureConnectorConfigSyncBinding } from "../../models/connector-content-sync.js"
import {
  getNotionBindingByConnectionId,
  transitionNotionBindingState,
} from "../../models/notion-connector.js"
import { syncNotionConfigYaml } from "../../services/notion/sync.js"
import { enqueueConnectorContentSync } from "../enqueue-connector-content-sync.js"

const notionSyncConfigInputSchema = z.object({
  contentSyncGeneration: z.number().int().nonnegative().default(0),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
  resources: z.array(
    z.object({
      externalId: z.string().min(1),
      type: z.enum(["page", "database"]),
      title: z.string().min(1),
      url: z.string().nullable().optional(),
      parentExternalId: z.string().nullable().optional(),
    }),
  ),
})

export const notionSyncConfig = defineWorkflow(
  { name: "notion-sync-config", schema: notionSyncConfigInputSchema },
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
    const binding = await step.run({ name: "load-notion-binding" }, () =>
      getNotionBindingByConnectionId(input.connectionId),
    )
    if (!binding) throw new Error("Notion binding is not configured")
    if (binding.orgId !== input.orgId) {
      throw new Error("Notion binding does not belong to organization")
    }
    if (
      !binding.enabled ||
      binding.setupPhase !== "awaiting_merge" ||
      !binding.pendingConfigPrCreating
    ) {
      throw new Error("Notion binding is not ready for configuration sync")
    }

    const result = await step.run({ name: "sync-config" }, () =>
      syncNotionConfigYaml({
        orgId: input.orgId,
        orgSlug: input.orgSlug,
        env: parseEnv(process.env),
        connectionId: input.connectionId,
        binding,
        resources: input.resources,
      }),
    )
    if (result.changed) {
      await step.run({ name: "persist-config-pr-state" }, async () => {
        const transitioned = await withOrgDbContext(input.orgId, () =>
          transitionNotionBindingState({
            connectionId: input.connectionId,
            expectedSetupPhase: "awaiting_merge",
            expectedPendingConfigPrCreating: true,
            repositoryId: binding.repositoryId,
            branch: binding.branch,
            pendingConfigPullUrl: result.pullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: "awaiting_merge",
          }),
        )
        if (!transitioned)
          throw new Error("Notion binding changed during configuration sync")
      })
    } else {
      await step.run({ name: "enqueue-initial-content-sync" }, async () => {
        if (
          !(await enqueueConnectorContentSync({
            orgId: input.orgId,
            orgSlug: input.orgSlug,
            connectionId: input.connectionId,
            provider: "notion",
            repositoryId: binding.repositoryId,
            branch: binding.branch,
            configKey: `config-workflow:${run.id}`,
          }))
        )
          throw new Error("Notion binding changed during configuration sync")
      })
    }
    return result
  },
)
