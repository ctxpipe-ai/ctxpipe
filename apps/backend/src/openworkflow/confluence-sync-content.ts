import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../config/env.js"
import { getForgeInstallationByOrgId } from "../models/atlassian-connector.js"
import { getConfluenceSyncTargetByOrgId } from "../models/confluence-sync-target.js"
import { confluenceSyncConfig } from "./confluence-sync-config.js"
import { syncConfluenceContent } from "../services/confluence/sync.js"

const confluenceSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  forgeInstallationId: z.string().min(1),
})

export const confluenceSyncContent = defineWorkflow(
  {
    name: "confluence-sync-content",
    schema: confluenceSyncContentInputSchema,
  },
  async ({ input, step }) => {
    const [forgeInstallation, target] = await step.run(
      { name: "resolve-sync-context" },
      async () => {
        const [installationRow, targetRow] = await Promise.all([
          getForgeInstallationByOrgId(input.orgId),
          getConfluenceSyncTargetByOrgId(input.orgId),
        ])
        return {
          installation: installationRow,
          target: targetRow,
        }
      },
    )
    if (
      !forgeInstallation ||
      forgeInstallation.id !== input.forgeInstallationId ||
      !forgeInstallation.cloudId ||
      !forgeInstallation.appSystemToken
    ) {
      throw new Error("Forge installation is not ready for Confluence sync")
    }
    if (!target) {
      throw new Error("Confluence sync target is not configured")
    }

    const contentResult = await step.run({ name: "sync-content" }, () =>
      syncConfluenceContent({
        orgId: input.orgId,
        env: parseEnv(process.env as Record<string, string | undefined>),
        forgeInstallation: {
          id: forgeInstallation.id,
          cloudId: forgeInstallation.cloudId,
          atlassianApiBaseUrl: forgeInstallation.atlassianApiBaseUrl,
          appSystemToken: forgeInstallation.appSystemToken,
        },
        target,
      }),
    )

    const configResult = await step.runWorkflow(confluenceSyncConfig.spec, {
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      forgeInstallationId: input.forgeInstallationId,
    })

    const status = contentResult.status

    return {
      status,
      spacesProcessed: contentResult.spacesProcessed,
      pagesProcessed: contentResult.pagesProcessed,
      pagesFailed: contentResult.pagesFailed,
      commitShas: contentResult.commitSha ? [contentResult.commitSha] : [],
      configPullUrl: configResult?.pullUrl,
      configChanged: configResult?.changed ?? false,
      errors: contentResult.errors,
    }
  },
)
