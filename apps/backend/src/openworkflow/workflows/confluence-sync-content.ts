import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import {
  getForgeInstallationByConnectionId,
  updateConfluenceSpaceSyncState,
} from "../../models/atlassian-connector.js"
import {
  finalizeConfluenceSyncTargetAfterContentWorkflow,
  getConfluenceSyncTargetWithRepoByConnectionId,
} from "../../models/confluence-sync-target.js"
import { parseConfluenceConfigYamlContent } from "../../services/confluence/config-yaml.js"
import { captureConfluenceContent } from "../../services/confluence/sync.js"
import { parsedRepoScopeSchema } from "../confluence-scope-repo-schema.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const inputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  orgSlug: z.string().min(1),
  scopeFromRepo: parsedRepoScopeSchema.optional(),
})

export const confluenceSyncContent = defineWorkflow(
  { name: "confluence-sync-content", schema: inputSchema },
  async ({ input, step, run }) => {
    const env = parseEnv(process.env)
    const context = await step.run(
      { name: "capture-confluence-target" },
      async () => {
        const target = await getConfluenceSyncTargetWithRepoByConnectionId(
          input.orgId,
          input.connectionId,
        )
        const installation = await getForgeInstallationByConnectionId(
          input.orgId,
          input.connectionId,
        )
        if (
          !installation?.cloudId ||
          !installation.appSystemToken ||
          ["revoked", "uninstalled"].includes(installation.status)
        )
          throw new Error("Forge installation is not ready for Confluence sync")
        if (
          !target?.enabled ||
          !["initial_sync", "live"].includes(target.setupPhase)
        )
          throw new Error("Confluence sync target is not live")
        const captured = await captureConnectorMirrorTarget({
          orgId: input.orgId,
          env,
          repositoryGitUrl: target.repositoryGitUrl,
          mirror: {
            provider: "confluence",
            connectionId: input.connectionId,
            repositoryId: target.repositoryId,
          },
        })
        const config = parseConfluenceConfigYamlContent(captured.config)
        if (!config) throw new Error("confluence/config.yaml was not found")
        return {
          target,
          captured,
          config,
          cloudId: installation.cloudId,
          atlassianApiBaseUrl: installation.atlassianApiBaseUrl,
        }
      },
    )
    const captured = await step.run(
      { name: "capture-confluence-content" },
      async () => {
        const installation = await getForgeInstallationByConnectionId(
          input.orgId,
          input.connectionId,
        )
        if (
          !installation?.appSystemToken ||
          installation.cloudId !== context.cloudId ||
          installation.atlassianApiBaseUrl !== context.atlassianApiBaseUrl ||
          ["revoked", "uninstalled"].includes(installation.status)
        )
          throw new Error("Confluence authorization changed")
        return captureConfluenceContent({
          forgeInstallation: {
            id: installation.id,
            cloudId: context.cloudId,
            appSystemToken: installation.appSystemToken,
            atlassianApiBaseUrl: context.atlassianApiBaseUrl,
          },
          config: context.config,
          existingPaths: context.captured.paths,
        })
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
            { name: "commit-confluence-mirror" },
          )
        : null
    await step.run({ name: "record-synced-spaces" }, () =>
      withOrgDbContext(input.orgId, async () => {
        for (const space of captured.syncedSpaces)
          await updateConfluenceSpaceSyncState({
            connectionId: input.connectionId,
            ...space,
            lastSyncedAt: run.createdAt,
          })
      }),
    )
    await step.run({ name: "finalize-setup-phase" }, () =>
      finalizeConfluenceSyncTargetAfterContentWorkflow({
        connectionId: input.connectionId,
        workflowStatus: captured.status,
        repositoryId: context.target.repositoryId,
        branch: context.target.branch,
      }),
    )
    return {
      status: captured.status,
      spacesProcessed: captured.spacesProcessed,
      pagesProcessed: captured.pagesProcessed,
      pagesFailed: captured.pagesFailed,
      commitShas: result?.committed ? [result.commitSha] : [],
      errors: captured.errors,
    }
  },
)
