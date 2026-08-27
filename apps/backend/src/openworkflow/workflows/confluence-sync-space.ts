import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { getForgeInstallationByConnectionId } from "../../models/atlassian-connector.js"
import { getConfluenceSyncTargetByConnectionId } from "../../models/confluence-sync-target.js"
import { getLogger } from "../../observability/logger.js"
import { syncConfluenceContent } from "../../services/confluence/sync.js"
import { runConnectorRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const confluenceSyncSpaceInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  spaceKey: z.string().min(1),
  pageId: z.string().optional(),
  eventType: z.string().optional(),
})

export const confluenceSyncSpace = defineWorkflow(
  {
    name: "confluence-sync-space",
    schema: confluenceSyncSpaceInputSchema,
  },
  async ({ input, step }) => {
    const forgeInstallation = await withOrgDbContext(input.orgId, (db) =>
      getForgeInstallationByConnectionId(input.orgId, input.connectionId, db),
    )
    const cloudId = forgeInstallation?.cloudId
    const appSystemToken = forgeInstallation?.appSystemToken
    if (!forgeInstallation || !cloudId || !appSystemToken) {
      throw new Error("Forge installation is not ready for Confluence sync")
    }

    const target = await step.run(
      { name: "load-confluence-space-target" },
      async () => {
        const current = await getConfluenceSyncTargetByConnectionId(
          input.connectionId,
        )
        if (!current) {
          throw new Error("Confluence sync target is not configured")
        }
        return current
      },
    )

    const result = await step.run({ name: "sync-confluence-space" }, () =>
      syncConfluenceContent({
        orgId: input.orgId,
        env: parseEnv(process.env as Record<string, string | undefined>),
        forgeInstallation: {
          id: forgeInstallation.id,
          cloudId,
          atlassianApiBaseUrl: forgeInstallation.atlassianApiBaseUrl,
          appSystemToken,
        },
        target,
        mode: {
          spaceKey: input.spaceKey,
          pageId: input.pageId,
          eventType: input.eventType,
        },
      }),
    )

    await step.run({ name: "ingest-confluence-space" }, () =>
      runConnectorRepositoryIngestionWorkflow(
        {
          repositoryId: target.repositoryId,
          orgId: input.orgId,
          targetBranch: target.branch,
          indexingReason: "Applying Confluence updates",
        },
        {
          error: (error) =>
            getLogger().error(error, {
              step: "confluence-sync-space.ingestion",
              connectionId: input.connectionId,
            }),
        },
      ),
    )

    return {
      ...result,
      spaceKey: input.spaceKey,
    }
  },
)
