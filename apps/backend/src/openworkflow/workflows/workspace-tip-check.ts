import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { firstConnectorTarget } from "../../domain/workspaces/migration-cutover.js"
import { runCronTipChecks } from "../../domain/workspaces/tip-resolve.js"
import {
  getPersistedFirstWorkspaceId,
  listOrgWorkspaces,
  persistFirstWorkspaceId,
  persistResolvedDesiredSha,
} from "../../models/workspaces.js"
import { resolveWorkspaceRepositoryTip } from "../../routes/webhooks/github/github-workspace-tip.js"
import { enqueueWorkspaceHydrate } from "../enqueue-workspace-hydrate.js"
import { enqueueWorkspaceWriteCommit } from "../enqueue-workspace-write-commit.js"

const workspaceTipCheckInputSchema = z.object({
  orgId: z.string().min(1),
})

export const workspaceTipCheck = defineWorkflow(
  { name: "workspace-tip-check", schema: workspaceTipCheckInputSchema },
  async ({ input }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    return withOrgDbContext(input.orgId, async () => {
      const workspaces = await listOrgWorkspaces(input.orgId)
      const persistedFirst = await getPersistedFirstWorkspaceId(input.orgId)
      if (!persistedFirst && workspaces.length > 0) {
        const first = firstConnectorTarget(workspaces)
        if (first) {
          await persistFirstWorkspaceId(first.id, input.orgId)
          for (const workspace of workspaces) {
            void enqueueWorkspaceWriteCommit(
              {
                orgId: input.orgId,
                workspaceId: workspace.id,
                kind: "migration_export",
              },
              { error: () => undefined },
            )
          }
        }
      }
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
      for (const workspaceId of updated) {
        void enqueueWorkspaceHydrate(
          { orgId: input.orgId, workspaceId },
          { error: () => undefined },
        )
      }
      return { updated: updated.length }
    })
  },
)
