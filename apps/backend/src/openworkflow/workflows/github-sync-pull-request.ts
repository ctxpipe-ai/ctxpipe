import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { captureConnectorMirrorTarget } from "../../domain/workspaces/capture-connector-mirror.js"
import { getGithubPrMirrorBinding } from "../../models/github-pr-mirror.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { parseGithubPrConfigYamlContent } from "../../services/github/pull-request-mirror/config-yaml.js"
import {
  isGithubPullRequestRepositoryInScope,
  shouldMirrorGithubPullRequest,
} from "../../services/github/pull-request-mirror/policy.js"
import { captureGithubPullRequest } from "../../services/github/pull-request-mirror/sync.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const GithubSyncPullRequestCandidateSchema = z.object({
  merged: z.boolean(),
  draft: z.boolean(),
  updatedAt: z.string().min(1),
})

export type GithubSyncPullRequestCandidate = z.infer<
  typeof GithubSyncPullRequestCandidateSchema
>

const GithubSyncPullRequestInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  sourceRepository: z.string().min(1),
  number: z.number().int().positive(),
  /** Webhook-provided facts; when present the scope policy runs before any GitHub API call. */
  candidate: GithubSyncPullRequestCandidateSchema.optional(),
})

export const githubSyncPullRequest = defineWorkflow(
  {
    name: "github-sync-pull-request",
    schema: GithubSyncPullRequestInputSchema,
  },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "github-sync-pull-request",
        orgId: input.orgId,
        connectionId: input.connectionId,
        sourceRepository: input.sourceRepository,
        pullRequestNumber: input.number,
      }),
      async () => {
        const env = parseEnv(process.env as Record<string, string | undefined>)
        const context = await step.run(
          { name: "load-github-pr-entity-context" },
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
            const captured = await captureConnectorMirrorTarget({
              repositoryGitUrl: binding.gitUrl,
              orgId: input.orgId,
              env,
              mirror: {
                provider: "github",
                connectionId: input.connectionId,
                repositoryId: binding.repositoryId,
              },
            })
            const config = parseGithubPrConfigYamlContent(captured.config)
            if (!config) return null
            return { binding, captured, config }
          },
        )
        if (!context) return { written: false }

        if (
          !isGithubPullRequestRepositoryInScope({
            config: context.config,
            repository: input.sourceRepository,
          })
        ) {
          return { written: false, skipped: "policy" as const }
        }

        if (
          input.candidate &&
          !shouldMirrorGithubPullRequest({
            config: context.config,
            candidate: {
              repository: input.sourceRepository,
              ...input.candidate,
            },
          })
        ) {
          return { written: false, skipped: "policy" as const }
        }

        const captured = await step.run(
          { name: "mirror-github-pull-request" },
          () =>
            captureGithubPullRequest({
              orgId: input.orgId,
              env,
              binding: context.binding,
              config: context.config,
              sourceRepository: input.sourceRepository,
              number: input.number,
            }),
        )
        if (captured.files.length || captured.deletePaths.length) {
          await step.runWorkflow(
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
            { name: "commit-github-pr-mirror" },
          )
          await step.run({ name: "ingest-github-pull-request" }, () =>
            runRepositoryIngestionWorkflow(
              {
                orgId: input.orgId,
                repositoryId: context.binding.repositoryId,
                targetBranch: context.binding.branch,
                indexingReason: "Mirroring GitHub pull requests",
              },
              {
                error: (error) =>
                  getLogger().error(error, {
                    step: "github-sync-pull-request.ingestion",
                    connectionId: input.connectionId,
                  }),
              },
            ),
          )
          return { written: true, path: captured.files[0]?.path }
        }
        return { written: false }
      },
    ),
)
