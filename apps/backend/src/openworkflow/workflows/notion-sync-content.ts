import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  finalizeNotionBindingAfterContentWorkflow,
  getNotionBindingByConnectionId,
  getNotionConnectionByConnectionId,
} from "../../models/notion-connector.js"
import { getLogger } from "../../observability/logger.js"
import { syncNotionContent } from "../../services/notion/sync.js"
import { claimAndRunRepositoryIngestionChild } from "../enqueue-repository-ingestion.js"
import { parsedNotionRepoScopeSchema } from "../notion-scope-repo-schema.js"

const notionSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
  scopeFromRepo: parsedNotionRepoScopeSchema.optional(),
})

export const notionSyncContent = defineWorkflow(
  { name: "notion-sync-content", schema: notionSyncContentInputSchema },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const markSyncFailed = () =>
      withOrgDbContext(input.orgId, () =>
        finalizeNotionBindingAfterContentWorkflow({
          connectionId: input.connectionId,
          workflowStatus: "failed",
        }),
      )
    const context = await step
      .run({ name: "load-notion-sync-context" }, () =>
        withOrgDbContext(input.orgId, async () => ({
          connection: await getNotionConnectionByConnectionId(
            input.orgId,
            input.connectionId,
            env,
          ),
          binding: await getNotionBindingByConnectionId(input.connectionId),
        })),
      )
      .catch(async (error) => {
        await markSyncFailed()
        throw error
      })
    if (!context.connection?.accessToken) {
      await markSyncFailed()
      throw new Error("Notion connection is not ready for sync")
    }
    if (!context.binding) {
      await markSyncFailed()
      throw new Error("Notion binding is not configured")
    }
    const notionConnection = context.connection
    const binding = context.binding
    if (
      binding.orgId !== input.orgId ||
      !binding.enabled ||
      binding.setupPhase !== "initial_sync"
    ) {
      await markSyncFailed()
      throw new Error("Notion binding is not ready for initial sync")
    }

    try {
      const contentResult = await step.run({ name: "sync-content" }, () =>
        syncNotionContent({
          orgId: input.orgId,
          env,
          notionConnection,
          binding,
          scopeFromRepo: input.scopeFromRepo,
        }),
      )

      // Git is the content SoT; hand off to repository ingestion so codesearch
      // indexes the mirrored notion/ files (Linear/PR-271 pattern).
      if (contentResult.status !== "failed") {
        await claimAndRunRepositoryIngestionChild(
          step,
          {
            repositoryId: binding.repositoryId,
            orgId: input.orgId,
            targetBranch: binding.branch,
            indexingReason: "Syncing Notion content",
          },
          {
            error: (error) =>
              getLogger().error(error, {
                step: "notion-sync-content.ingestion",
                connectionId: input.connectionId,
              }),
          },
        )
      }

      await step.run({ name: "finalize-setup-phase" }, () =>
        withOrgDbContext(input.orgId, () =>
          finalizeNotionBindingAfterContentWorkflow({
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
