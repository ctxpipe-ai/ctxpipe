import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getNotionSyncTargetByConnectionId,
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
    const target = await step.run({ name: "load-sync-target" }, () =>
      getNotionSyncTargetByConnectionId(input.connectionId),
    )
    if (!target) throw new Error("Notion sync target is not configured")
    if (target.orgId !== input.orgId) {
      throw new Error("Notion sync target does not belong to organization")
    }
    if (
      !target.enabled ||
      target.setupPhase !== "awaiting_merge" ||
      !target.pendingConfigPrCreating
    ) {
      throw new Error("Notion sync target is not ready for configuration sync")
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
          target,
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
              repositoryId: target.repositoryId,
              branch: target.branch,
              pendingConfigPullUrl: result.changed
                ? (result.pullUrl ?? null)
                : null,
              pendingConfigPrCreating: false,
              setupPhase: result.changed ? "awaiting_merge" : "initial_sync",
            }),
          ),
      )
      if (!transitioned) {
        throw new Error("Notion sync target changed during configuration sync")
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
            repositoryId: target.repositoryId,
            branch: target.branch,
            pendingConfigPullUrl: target.pendingConfigPullUrl ?? null,
            pendingConfigPrCreating: false,
            setupPhase: "config_failed",
          }),
        ),
      )
      throw e
    }
  },
)
