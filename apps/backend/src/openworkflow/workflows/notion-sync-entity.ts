import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import {
  getNotionBindingWithRepoByConnectionId,
  getNotionConnectionByConnectionId,
} from "../../models/notion-connector.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { parseNotionConfigYamlContent } from "../../services/notion/config-yaml.js"
import { captureNotionIncrementalContent } from "../../services/notion/sync.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const inputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  entityType: z.enum(["page", "database", "data_source"]),
  externalId: z.string().min(1),
  action: z.enum(["upsert", "delete"]),
  eventId: z.string().optional(),
})

export const notionSyncEntity = defineWorkflow(
  { name: "notion-sync-entity", schema: inputSchema },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "notion-sync-entity",
        orgId: input.orgId,
        connectionId: input.connectionId,
      }),
      async () => {
        const env = parseEnv(process.env)
        const context = await step.run(
          { name: "capture-notion-target" },
          async () => {
            const binding = await getNotionBindingWithRepoByConnectionId(
              input.orgId,
              input.connectionId,
            )
            const connection = await withOrgDbContext(input.orgId, () =>
              getNotionConnectionByConnectionId(
                input.orgId,
                input.connectionId,
                env,
              ),
            )
            if (!connection?.accessToken)
              throw new Error("Notion connection is not ready for sync")
            if (!binding?.githubConnectionId)
              throw new Error("Notion binding is not configured")
            if (
              connection.status !== "installed" ||
              !binding.enabled ||
              binding.setupPhase !== "live"
            ) {
              return null
            }
            const captured = await captureConnectorMirrorTarget({
              orgId: input.orgId,
              env,
              repositoryGitUrl: binding.repositoryGitUrl,
              mirror: {
                provider: "notion",
                connectionId: input.connectionId,
                repositoryId: binding.repositoryId,
              },
            })
            const config = parseNotionConfigYamlContent(captured.config)
            if (!config)
              throw new Error(
                "Notion scope configuration is missing from the repository; expected notion/config.yaml",
              )
            return {
              binding,
              captured,
              config,
              providerWorkspaceId: connection.workspaceId,
            }
          },
        )
        if (!context) return { written: 0, deleted: 0, errors: [] }
        const captured = await step.run(
          {
            name: "capture-notion-content",
            retryPolicy: {
              maximumAttempts: 5,
              initialInterval: "1m",
              backoffCoefficient: 3,
              maximumInterval: "4h",
            },
          },
          async () => {
            const connection = await withOrgDbContext(input.orgId, () =>
              getNotionConnectionByConnectionId(
                input.orgId,
                input.connectionId,
                env,
              ),
            )
            if (
              !connection?.accessToken ||
              connection.status !== "installed" ||
              connection.workspaceId !== context.providerWorkspaceId
            )
              throw new Error("Notion authorization changed")
            const captured = await captureNotionIncrementalContent({
              orgId: input.orgId,
              env,
              notionConnection: connection,
              config: context.config,
              existingPaths: context.captured.paths,
              entity: {
                entityType: input.entityType,
                externalId: input.externalId,
                action: input.action,
              },
            })
            if (captured.status === "failed")
              throw new Error(
                `Notion entity sync failed: ${captured.errors.map((error) => `${error.externalId}: ${error.message}`).join("; ")}`,
              )
            return captured
          },
        )
        const result =
          captured.status !== "failed" &&
          (captured.files.length || captured.deletePaths.length)
            ? await step.runWorkflow(
                workspaceConnectorMirror.spec,
                {
                  orgId: input.orgId,
                  workspaceId: context.captured.workspaceId,
                  revision: context.captured.revision,
                  mirror: context.captured.mirror,
                  jobId: `wjob_${run.id}_mirror`,
                  files: captured.files,
                  deletePaths: captured.deletePaths,
                },
                { name: "commit-notion-mirror" },
              )
            : null
        if (result?.committed) {
          await step.run({ name: "ingest-notion-content" }, () =>
            runRepositoryIngestionWorkflow(
              {
                orgId: input.orgId,
                repositoryId: context.binding.repositoryId,
                targetBranch: context.binding.branch,
                indexingReason: "Syncing Notion content",
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
          written: result?.committed ? captured.written : 0,
          deleted: result?.committed ? captured.deleted : 0,
          errors: captured.errors,
        }
      },
    ),
)
