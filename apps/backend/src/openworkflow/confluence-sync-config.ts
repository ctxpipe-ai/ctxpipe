import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../config/env.js"
import { getConfluenceSyncTargetByForgeInstallationId } from "../models/confluence-sync-target.js"
import { syncConfluenceConfigYaml } from "../services/confluence/sync.js"

const confluenceSyncConfigInputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  forgeInstallationId: z.string().min(1),
})

export const confluenceSyncConfig = defineWorkflow(
  {
    name: "confluence-sync-config",
    schema: confluenceSyncConfigInputSchema,
  },
  async ({ input }) => {
    const target = await getConfluenceSyncTargetByForgeInstallationId(
      input.forgeInstallationId,
    )
    if (!target) {
      throw new Error("Confluence sync target is not configured")
    }
    if (target.orgId !== input.orgId) {
      throw new Error("Confluence sync target does not belong to organization")
    }
    return syncConfluenceConfigYaml({
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      env: parseEnv(process.env as Record<string, string | undefined>),
      forgeInstallationId: input.forgeInstallationId,
      target,
    })
  },
)
