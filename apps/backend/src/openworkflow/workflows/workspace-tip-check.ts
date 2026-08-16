import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { runCronTipChecks } from "../../domain/workspaces/tip-resolve.js"
import {
  listOrgWorkspaces,
  persistResolvedDesiredSha,
} from "../../models/workspaces.js"
import { resolveWorkspaceRepositoryTip } from "../../routes/webhooks/github/github-workspace-tip.js"

const workspaceTipCheckInputSchema = z.object({
  orgId: z.string().min(1),
})

export const workspaceTipCheck = defineWorkflow(
  { name: "workspace-tip-check", schema: workspaceTipCheckInputSchema },
  async ({ input }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    return withOrgDbContext(input.orgId, async () => {
      const workspaces = await listOrgWorkspaces(input.orgId)
      const updated = await runCronTipChecks({
        workspaces,
        resolveTip: (workspaceRepositoryUrl) => {
          const row = workspaces.find(
            (item) => item.workspaceRepositoryUrl === workspaceRepositoryUrl,
          )
          return resolveWorkspaceRepositoryTip({
            orgId: input.orgId,
            githubConnectionId: row?.githubConnectionId,
            workspaceRepositoryUrl,
            env,
          })
        },
        persist: persistResolvedDesiredSha,
      })
      return { updated }
    })
  },
)
