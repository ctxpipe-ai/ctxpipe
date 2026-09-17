import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  bindGithubPrMirror,
  getGithubPrMirrorBinding,
  patchGithubPrMirror,
} from "../../models/github-pr-mirror.js"
import { listRepositoriesForGithubConnection } from "../../models/repositories.js"
import { syncGithubPrMirrorConfigYaml } from "../../services/github/pull-request-mirror/sync.js"

const GithubSyncConfigInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  repositoryId: z.string().min(1),
  branch: z.string().min(1),
})

export const githubSyncConfig = defineWorkflow(
  {
    name: "github-sync-config",
    schema: GithubSyncConfigInputSchema,
  },
  async ({ input }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const binding = await withOrgDbContext(input.orgId, async () => {
      await bindGithubPrMirror({
        orgId: input.orgId,
        connectionId: input.connectionId,
        repositoryId: input.repositoryId,
        branch: input.branch,
      })
      return getGithubPrMirrorBinding(input.orgId, input.connectionId)
    })
    if (!binding) throw new Error("GitHub pull request mirror is not bound")

    try {
      const repositories = await withOrgDbContext(input.orgId, () =>
        listRepositoriesForGithubConnection(input.connectionId),
      )
      const scoped = repositories
        .map((repository) => repository.name)
        .filter((name) => name !== binding.repositoryName)
      const result = await syncGithubPrMirrorConfigYaml({
        orgId: input.orgId,
        env,
        binding,
        repositories: scoped,
      })
      await withOrgDbContext(input.orgId, () =>
        patchGithubPrMirror({
          orgId: input.orgId,
          connectionId: input.connectionId,
          patch: {
            setupPhase: "awaiting_merge",
            pendingConfigPullUrl: result.pullUrl,
          },
        }),
      )
      return { pullUrl: result.pullUrl, pullNumber: result.pullNumber }
    } catch (error) {
      await withOrgDbContext(input.orgId, () =>
        patchGithubPrMirror({
          orgId: input.orgId,
          connectionId: input.connectionId,
          patch: { setupPhase: "config_failed" },
        }),
      )
      throw error
    }
  },
)
