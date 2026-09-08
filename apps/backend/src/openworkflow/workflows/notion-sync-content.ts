import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import {
  finalizeNotionBindingAfterContentWorkflow,
  getNotionBindingWithRepoByConnectionId,
  getNotionConnectionByConnectionId,
} from "../../models/notion-connector.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { parseNotionConfigYamlContent } from "../../services/notion/config-yaml.js"
import { captureNotionContent } from "../../services/notion/sync.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { parsedNotionRepoScopeSchema } from "../notion-scope-repo-schema.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const inputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  orgSlug: z.string().min(1),
  scopeFromRepo: parsedNotionRepoScopeSchema.optional(),
})

export const notionSyncContent = defineWorkflow(
  { name: "notion-sync-content", schema: inputSchema },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "notion-sync-content",
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
              binding.setupPhase !== "initial_sync"
            ) {
              throw new Error("Notion binding is not ready for initial sync")
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

        const captured = await step.run(
          { name: "capture-notion-content" },
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
            const captured = await captureNotionContent({
              orgId: input.orgId,
              env,
              notionConnection: connection,
              config: context.config,
              existingPaths: context.captured.paths,
            })

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
        if (captured.status !== "failed") {
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
                    step: "notion-sync-content.ingestion",
                    connectionId: input.connectionId,
                  }),
              },
            ),
          )
        }
        await step.run({ name: "finalize-setup-phase" }, () =>
          finalizeNotionBindingAfterContentWorkflow({
            connectionId: input.connectionId,
            workflowStatus: captured.status,
            repositoryId: context.binding.repositoryId,
            branch: context.binding.branch,
          }),
        )
        return {
          status: captured.status,
          resourcesProcessed: captured.resourcesProcessed,
          resourcesFailed: captured.resourcesFailed,
          commitShas: result?.committed ? [result.commitSha] : [],
          errors: captured.errors,
        }
      },
    ),
)
