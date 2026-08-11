import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getNotionBindingByConnectionId,
  transitionNotionBindingState,
} from "../../models/notion-connector.js"
import { syncNotionConfigYaml } from "../../services/notion/sync.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { notionSyncContent } from "./notion-sync-content.js"

const notionSyncConfigInputSchema = z.object({
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
  async ({ input, step }) => {
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

    let expectedPhase: "awaiting_merge" | "initial_sync" = "awaiting_merge"
    let expectedPendingConfigPrCreating = true
    try {
      const result = await step.run({ name: "sync-config" }, () =>
        syncNotionConfigYaml({
          orgId: input.orgId,
          orgSlug: input.orgSlug,
          env: parseEnv(process.env as Record<string, string | undefined>),
          connectionId: input.connectionId,
          binding,
          resources: input.resources,
        }),
      )
      const transitioned = await step.run(
        { name: "persist-config-pr-state" },
        () =>
          withOrgDbContext(input.orgId, () =>
            transitionNotionBindingState({
              connectionId: input.connectionId,
              expectedSetupPhase: "awaiting_merge",
              expectedPendingConfigPrCreating: true,
              repositoryId: binding.repositoryId,
              branch: binding.branch,
              pendingConfigPullUrl: result.changed
                ? (result.pullUrl ?? null)
                : null,
              pendingConfigPrCreating: false,
              setupPhase: result.changed ? "awaiting_merge" : "initial_sync",
            }),
          ),
      )
      if (!transitioned) {
        throw new Error("Notion binding changed during configuration sync")
      }
      if (!result.changed) {
        expectedPhase = "initial_sync"
        expectedPendingConfigPrCreating = false
        await step.run({ name: "enqueue-initial-content-sync" }, () =>
          runWorkflowWithWorkerWake(notionSyncContent.spec, {
            orgId: input.orgId,
            orgSlug: input.orgSlug,
            connectionId: input.connectionId,
          }),
        )
      }
      return result
    } catch (e) {
      await step.run({ name: "mark-config-failed" }, () =>
        withOrgDbContext(input.orgId, () =>
          transitionNotionBindingState({
            connectionId: input.connectionId,
            expectedSetupPhase: expectedPhase,
            expectedPendingConfigPrCreating,
            repositoryId: binding.repositoryId,
            branch: binding.branch,
            pendingConfigPullUrl: binding.pendingConfigPullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: "config_failed",
          }),
        ),
      )
      throw e
    }
  },
)
