import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  finalizePagerdutyBindingAfterContentWorkflow,
  getPagerdutyBindingByConnectionId,
  getPagerdutyConnectionByConnectionId,
} from "../../models/pagerduty-connector.js"
import { getLogger } from "../../observability/logger.js"
import { syncPagerdutyContent } from "../../services/pagerduty/sync.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runConnectorRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const pagerdutySyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
})

export const pagerdutySyncContent = defineWorkflow(
  {
    name: "pagerduty-sync-content",
    schema: pagerdutySyncContentInputSchema,
  },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const markSyncFailed = () =>
      withOrgDbContext(input.orgId, () =>
        finalizePagerdutyBindingAfterContentWorkflow({
          connectionId: input.connectionId,
          workflowStatus: "failed",
        }),
      )
    const context = await step
      .run({ name: "load-pagerduty-sync-context" }, () =>
        withOrgDbContext(input.orgId, async () => ({
          connection: await getPagerdutyConnectionByConnectionId(
            input.orgId,
            input.connectionId,
            env,
          ),
          binding: await getPagerdutyBindingByConnectionId(input.connectionId),
        })),
      )
      .catch(async (error) => {
        await markSyncFailed()
        throw error
      })
    if (!context.connection) {
      await markSyncFailed()
      throw new Error("PagerDuty connection is not ready for sync")
    }
    if (!context.binding) {
      await markSyncFailed()
      throw new Error("PagerDuty binding is not configured")
    }
    const connection = context.connection
    const binding = context.binding
    if (
      binding.orgId !== input.orgId ||
      !binding.enabled ||
      binding.setupPhase !== "initial_sync"
    ) {
      await markSyncFailed()
      throw new Error("PagerDuty binding is not ready for initial sync")
    }

    try {
      const contentResult = await step.run({ name: "sync-content" }, () =>
        syncPagerdutyContent({
          orgId: input.orgId,
          env,
          connection,
          binding,
        }),
      )

      if (contentResult.status !== "failed") {
        await runConnectorRepositoryIngestionWorkflow(
          step,
          {
            repositoryId: binding.repositoryId,
            orgId: input.orgId,
            targetBranch: binding.branch,
            indexingReason: "Syncing PagerDuty content",
          },
          {
            error: (error) =>
              getLogger().error(error, {
                step: "pagerduty-sync-content.ingestion",
                connectionId: input.connectionId,
              }),
          },
        )
      }

      await step.run({ name: "finalize-setup-phase" }, () =>
        withOrgDbContext(input.orgId, () =>
          finalizePagerdutyBindingAfterContentWorkflow({
            connectionId: input.connectionId,
            workflowStatus: contentResult.status,
          }),
        ),
      )

      return {
        status: contentResult.status,
        resourcesProcessed: contentResult.resourcesProcessed,
        resourcesFailed: contentResult.resourcesFailed,
        commitShas: contentResult.commitSha ? [contentResult.commitSha] : [],
        errors: contentResult.errors,
      }
    } catch (error) {
      await markSyncFailed()
      throw error
    }
  },
)
