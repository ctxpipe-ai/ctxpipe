import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { getForgeInstallationByConnectionId } from "../models/atlassian-connector.js"
import {
  finalizeConfluenceSyncTargetAfterContentWorkflow,
  getConfluenceSyncTargetByConnectionId,
} from "../models/confluence-sync-target.js"
import { syncConfluenceContent } from "../services/confluence/sync.js"
import { parsedRepoScopeSchema } from "./confluence-scope-repo-schema.js"

const confluenceSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
  /** GitHub push path — avoids second Git fetch inside workflow */
  scopeFromRepo: parsedRepoScopeSchema.optional(),
})

export const confluenceSyncContent = defineWorkflow(
  {
    name: "confluence-sync-content",
    schema: confluenceSyncContentInputSchema,
  },
  async ({ input, step }) => {
    const resolveSyncContextResult = await step.run(
      { name: "load-confluence-sync-context" },
      async () => {
        return withOrgDbContext(input.orgId, async () => {
          const installationRow = await getForgeInstallationByConnectionId(
            input.orgId,
            input.connectionId,
          )
          const targetRow = await getConfluenceSyncTargetByConnectionId(
            input.connectionId,
          )
          return {
            installation: installationRow,
            target: targetRow,
          }
        })
      },
    )
    const { installation: forgeInstallation, target } = resolveSyncContextResult
    if (!forgeInstallation) {
      throw new Error("Forge installation is not ready for Confluence sync")
    }
    const cloudId = forgeInstallation.cloudId
    const appSystemToken = forgeInstallation.appSystemToken
    if (!cloudId || !appSystemToken) {
      throw new Error("Forge installation is not ready for Confluence sync")
    }
    if (!target) {
      throw new Error("Confluence sync target is not configured")
    }

    const scopeFromRepo = input.scopeFromRepo
      ? {
          spaces: input.scopeFromRepo.spaces.map((s) => ({
            spaceKey: s.spaceKey,
            selectedPageIds: s.selectedPageIds,
          })),
        }
      : undefined

    const contentResult = await step.run({ name: "sync-content" }, () =>
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
        scopeFromRepo,
      }),
    )

    const status = contentResult.status

    await step.run({ name: "finalize-setup-phase" }, async () =>
      withOrgDbContext(input.orgId, () =>
        finalizeConfluenceSyncTargetAfterContentWorkflow({
          connectionId: input.connectionId,
          workflowStatus: status,
        }),
      ),
    )

    return {
      status,
      spacesProcessed: contentResult.spacesProcessed,
      pagesProcessed: contentResult.pagesProcessed,
      pagesFailed: contentResult.pagesFailed,
      commitShas: contentResult.commitSha ? [contentResult.commitSha] : [],
      errors: contentResult.errors,
    }
  },
)
