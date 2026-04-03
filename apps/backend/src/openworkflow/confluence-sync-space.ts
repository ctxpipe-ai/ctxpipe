import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../config/env.js"
import { getForgeInstallationByOrgId } from "../models/atlassian-connector.js"
import { getConfluenceSyncTargetByOrgId } from "../models/confluence-sync-target.js"
import { syncConfluenceContent } from "../services/confluence/sync.js"

const confluenceSyncSpaceInputSchema = z.object({
  orgId: z.string().min(1),
  forgeInstallationId: z.string().min(1),
  spaceKey: z.string().min(1),
  pageId: z.string().optional(),
  eventType: z.string().optional(),
})

export const confluenceSyncSpace = defineWorkflow(
  {
    name: "confluence-sync-space",
    schema: confluenceSyncSpaceInputSchema,
  },
  async ({ input }) => {
    const forgeInstallation = await getForgeInstallationByOrgId(input.orgId)
    if (
      !forgeInstallation ||
      forgeInstallation.id !== input.forgeInstallationId ||
      !forgeInstallation.cloudId ||
      !forgeInstallation.appSystemToken
    ) {
      throw new Error("Forge installation is not ready for Confluence sync")
    }

    const target = await getConfluenceSyncTargetByOrgId(input.orgId)
    if (!target) {
      throw new Error("Confluence sync target is not configured")
    }

    const result = await syncConfluenceContent({
      orgId: input.orgId,
      env: parseEnv(process.env as Record<string, string | undefined>),
      forgeInstallation: {
        id: forgeInstallation.id,
        cloudId: forgeInstallation.cloudId,
        atlassianApiBaseUrl: forgeInstallation.atlassianApiBaseUrl,
        appSystemToken: forgeInstallation.appSystemToken,
      },
      target,
      mode: {
        spaceKey: input.spaceKey,
        pageId: input.pageId,
        eventType: input.eventType,
      },
    })

    return {
      ...result,
      spaceKey: input.spaceKey,
    }
  },
)
