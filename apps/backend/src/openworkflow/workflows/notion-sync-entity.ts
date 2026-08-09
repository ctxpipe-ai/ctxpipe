import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getNotionConnectionByConnectionId,
  getNotionSyncTargetWithRepoByConnectionId,
} from "../../models/notion-connector.js"
import { getLogger } from "../../observability/logger.js"
import { loadNotionScopeFromRepo } from "../../services/notion/config-from-repo.js"
import { syncNotionIncrementalContent } from "../../services/notion/sync.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const notionSyncEntityInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  entityType: z.enum(["page", "database", "data_source"]),
  externalId: z.string().min(1),
  action: z.enum(["upsert", "delete"]),
  eventId: z.string().optional(),
})

export const notionSyncEntity = defineWorkflow(
  { name: "notion-sync-entity", schema: notionSyncEntityInputSchema },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const context = await step.run(
      { name: "load-notion-entity-context" },
      async () => {
        const [connection, target] = await Promise.all([
          withOrgDbContext(input.orgId, () =>
            getNotionConnectionByConnectionId(input.orgId, input.connectionId),
          ),
          getNotionSyncTargetWithRepoByConnectionId(
            input.orgId,
            input.connectionId,
          ),
        ])
        if (!connection?.accessToken) {
          throw new Error("Notion connection is not ready for sync")
        }
        if (!target?.githubConnectionId) {
          throw new Error("Notion sync target is not configured")
        }
        if (
          connection.status !== "installed" ||
          !target.enabled ||
          target.setupPhase !== "live"
        ) {
          return null
        }
        const config = await loadNotionScopeFromRepo({
          orgId: input.orgId,
          env,
          repositoryName: target.repositoryName,
          githubConnectionId: target.githubConnectionId,
          branch: target.branch,
        })
        if (!config) {
          throw new Error(
            "Notion scope configuration is missing from the repository; expected notion/config.yaml",
          )
        }
        return { connection, target, config }
      },
    )
    if (!context) {
      return { written: 0, deleted: 0, errors: [] }
    }

    const result = await step.run(
      {
        name: "apply-notion-entity",
        retryPolicy: {
          maximumAttempts: 5,
          initialInterval: "1m",
          backoffCoefficient: 3,
          maximumInterval: "4h",
        },
      },
      async () => {
        const syncResult = await syncNotionIncrementalContent({
          orgId: input.orgId,
          env,
          notionConnection: context.connection,
          target: context.target,
          config: context.config,
          entity: {
            entityType: input.entityType,
            externalId: input.externalId,
            action: input.action,
          },
        })
        if (syncResult.status === "failed") {
          throw new Error(
            `Notion entity sync failed: ${syncResult.errors
              .map((error) => `${error.externalId}: ${error.message}`)
              .join("; ")}`,
          )
        }
        return syncResult
      },
    )

    if (result.written > 0 || result.deleted > 0) {
      await step.run({ name: "ingest-notion-entity" }, () =>
        runRepositoryIngestionWorkflow(
          {
            repositoryId: context.target.repositoryId,
            orgId: input.orgId,
            indexingReason: "Applying Notion updates",
          },
          {
            error: (error) =>
              getLogger().error(error, {
                step: "notion-sync-entity.ingestion",
                connectionId: input.connectionId,
              }),
          },
        ),
      )
    }

    return {
      written: result.written,
      deleted: result.deleted,
      errors: result.errors,
    }
  },
)
