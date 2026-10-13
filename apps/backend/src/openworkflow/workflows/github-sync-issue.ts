import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { getGithubPrMirrorBinding } from "../../models/github-pr-mirror.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { syncGithubIssueToGit } from "../../services/github/issue-mirror/sync.js"
import { loadGithubPrMirrorConfigFromRepo } from "../../services/github/pull-request-mirror/config-from-repo.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runConnectorRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"

const GithubSyncIssueInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  sourceRepository: z.string().min(1),
  number: z.number().int().positive(),
})

/** Webhook entity sync for one GitHub issue on the pull-request mirror binding. */
export const githubSyncIssue = defineWorkflow(
  {
    name: "github-sync-issue",
    schema: GithubSyncIssueInputSchema,
  },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const context = await step.run(
      { name: "load-github-issue-entity-context" },
      async () => {
        const binding = await getGithubPrMirrorBinding(
          input.orgId,
          input.connectionId,
        )
        if (
          !binding?.enabled ||
          (binding.setupPhase !== "live" &&
            binding.setupPhase !== "initial_sync")
        ) {
          return null
        }
        const config = await loadGithubPrMirrorConfigFromRepo({
          orgId: input.orgId,
          env,
          repositoryName: binding.repositoryName,
          githubConnectionId: binding.githubConnectionId,
          branch: binding.branch,
        })
        if (
          !config?.issues ||
          !config.repositories.includes(input.sourceRepository)
        ) {
          return null
        }
        return { binding }
      },
    )
    if (!context) return { written: false }

    const result = await step.run({ name: "mirror-github-issue" }, () =>
      syncGithubIssueToGit({
        orgId: input.orgId,
        env,
        binding: context.binding,
        sourceRepository: input.sourceRepository,
        number: input.number,
      }),
    )
    await withLogger(
      createLogger({
        workflow: "github-sync-issue",
        orgId: input.orgId,
        connectionId: input.connectionId,
        sourceRepository: input.sourceRepository,
        issueNumber: input.number,
      }),
      () =>
        runConnectorRepositoryIngestionWorkflow(
          step,
          {
            orgId: input.orgId,
            repositoryId: context.binding.repositoryId,
            targetBranch: context.binding.branch,
            indexingReason: "Mirroring GitHub issues",
          },
          {
            error: (error) =>
              getLogger().error(error, {
                step: "github-sync-issue.ingestion",
                connectionId: input.connectionId,
              }),
          },
        ),
    )
    return result
  },
)
