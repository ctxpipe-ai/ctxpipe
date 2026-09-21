import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  getGithubPrMirrorBinding,
  patchGithubPrMirror,
} from "../../models/github-pr-mirror.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { loadGithubPrMirrorConfigFromRepo } from "../../services/github/pull-request-mirror/config-from-repo.js"
import { syncGithubPullRequestsForConfig } from "../../services/github/pull-request-mirror/sync.js"
import { runConnectorRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { isWorkflowControlSignal } from "../isSleepSignal.js"

const GithubSyncContentInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
})

export function githubPrMirrorContentIdempotencyKey(input: {
  connectionId: string
  commitSha: string
}): string {
  return `github-pr-mirror-content:${input.connectionId}:${input.commitSha}`
}

export const githubSyncContent = defineWorkflow(
  {
    name: "github-sync-content",
    schema: GithubSyncContentInputSchema,
  },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const context = await step.run(
      { name: "load-github-pr-mirror" },
      async () => {
        const binding = await getGithubPrMirrorBinding(
          input.orgId,
          input.connectionId,
        )
        if (!binding?.enabled) {
          throw new Error("GitHub pull request mirror is not bound")
        }
        const config = await loadGithubPrMirrorConfigFromRepo({
          orgId: input.orgId,
          env,
          repositoryName: binding.repositoryName,
          githubConnectionId: binding.githubConnectionId,
          branch: binding.branch,
        })
        if (!config) throw new Error("github/config.yaml was not found")
        return { binding, config }
      },
    )

    try {
      await withOrgDbContext(input.orgId, () =>
        patchGithubPrMirror({
          orgId: input.orgId,
          connectionId: input.connectionId,
          patch: { setupPhase: "initial_sync" },
        }),
      )
      const result = await step.run(
        { name: "mirror-github-pull-requests" },
        () =>
          syncGithubPullRequestsForConfig({
            orgId: input.orgId,
            env,
            binding: context.binding,
            config: context.config,
          }),
      )
      await withLogger(
        createLogger({
          workflow: "github-sync-content",
          orgId: input.orgId,
          connectionId: input.connectionId,
        }),
        () =>
          runConnectorRepositoryIngestionWorkflow(
            step,
            {
              orgId: input.orgId,
              repositoryId: context.binding.repositoryId,
              targetBranch: context.binding.branch,
              indexingReason: "Mirroring GitHub pull requests",
            },
            {
              error: (error) =>
                getLogger().error(error, {
                  step: "github-sync-content.ingestion",
                  connectionId: input.connectionId,
                }),
            },
          ),
      )
      await withOrgDbContext(input.orgId, () =>
        patchGithubPrMirror({
          orgId: input.orgId,
          connectionId: input.connectionId,
          patch: { setupPhase: "live" },
        }),
      )
      return result
    } catch (error) {
      if (isWorkflowControlSignal(error)) throw error
      await withOrgDbContext(input.orgId, () =>
        patchGithubPrMirror({
          orgId: input.orgId,
          connectionId: input.connectionId,
          patch: { setupPhase: "sync_failed" },
        }),
      )
      throw error
    }
  },
)
