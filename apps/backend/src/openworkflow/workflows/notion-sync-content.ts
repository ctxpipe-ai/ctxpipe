import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  finalizeNotionSyncTargetAfterContentWorkflow,
  getNotionConnectionByConnectionId,
  getNotionSyncTargetByConnectionId,
} from "../../models/notion-connector.js"
import { getLogger } from "../../observability/logger.js"
import { syncNotionContent } from "../../services/notion/sync.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
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
    const context = await step.run({ name: "load-notion-sync-context" }, () =>
      withOrgDbContext(input.orgId, async () => ({
        connection: await getNotionConnectionByConnectionId(
          input.orgId,
          input.connectionId,
          env,
        ),
        target: await getNotionSyncTargetByConnectionId(input.connectionId),
      })),
    )
    if (!context.connection?.accessToken) {
      throw new Error("Notion connection is not ready for sync")
    }
    if (!context.target) {
      throw new Error("Notion sync target is not configured")
    }
    const notionConnection = context.connection
    const target = context.target

    const contentResult = await step.run({ name: "sync-content" }, () =>
      syncNotionContent({
        orgId: input.orgId,
        env,
        notionConnection,
        target,
        scopeFromRepo: input.scopeFromRepo,
      }),
    )

    // Git is the content SoT; hand off to repository ingestion so codesearch
    // indexes the mirrored notion/ files (Linear/PR-271 pattern).
    if (contentResult.status !== "failed") {
      await step.run({ name: "ingest-notion-content" }, () =>
        runRepositoryIngestionWorkflow(
          {
            repositoryId: target.repositoryId,
            orgId: input.orgId,
            indexingReason: "Syncing Notion content",
          },
          {
            error: (error) =>
              getLogger().error(error, {
                step: "notion-sync-content.ingestion",
                connectionId: input.connectionId,
              }),
          },
        ),
      )
    }

    await step.run({ name: "finalize-setup-phase" }, () =>
      withOrgDbContext(input.orgId, () =>
        finalizeNotionSyncTargetAfterContentWorkflow({
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
  },
)
