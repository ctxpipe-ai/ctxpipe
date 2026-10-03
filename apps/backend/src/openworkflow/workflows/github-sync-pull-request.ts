import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { captureGithubPrMirrorTarget } from "../../domain/workspaces/capture-github-pr-mirror.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { shouldMirrorGithubPullRequest } from "../../services/github/pull-request-mirror/policy.js"
import { captureGithubPullRequests } from "../../services/github/pull-request-mirror/sync.js"
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
  /** One run per Workspace that links the repository. */
  workspaceId: z.string().min(1),
  /** Normalized URL of the linked repository the pull request belongs to. */
  gitUrl: z.string().min(1),
  number: z.number().int().positive(),
  /** Webhook-provided facts; when present the policy runs before any GitHub API call. */
  candidate: GithubSyncPullRequestCandidateSchema.optional(),
})

/** Mirror one pull request into one Workspace that links its repository. */
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
        workspaceId: input.workspaceId,
        gitUrl: input.gitUrl,
        pullRequestNumber: input.number,
      }),
      async () => {
        if (input.candidate && !shouldMirrorGithubPullRequest(input.candidate))
          return { written: false, skipped: "policy" as const }
        const env = parseEnv(process.env as Record<string, string | undefined>)
        const target = await step.run(
          { name: "capture-github-pr-mirror-target" },
          () =>
            captureGithubPrMirrorTarget({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              gitUrl: input.gitUrl,
              env,
            }),
        )
        if ("skipped" in target)
          return { written: false, skipped: target.skipped }

        const captured = await step.run(
          { name: "mirror-github-pull-request" },
          () =>
            captureGithubPullRequests({
              orgId: input.orgId,
              env,
              connectionId: target.source.connectionId,
              repository: target.source.repository,
              numbers: [input.number],
            }),
        )
        const file = captured.files[0]
        if (!file) return { written: false, skipped: "policy" as const }
        await step.runWorkflow(
          workspaceConnectorMirror.spec,
          {
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            revision: target.revision,
            mirror: target.mirror,
            jobId: `wjob_${run.id}_mirror`,
            files: captured.files,
            deletePaths: [],
          },
          { name: "commit-github-pr-mirror" },
        )
        const workspaceRepositoryId = target.workspaceRepositoryId
        if (workspaceRepositoryId)
          await step.run({ name: "ingest-github-pull-request" }, () =>
            runRepositoryIngestionWorkflow(
              {
                orgId: input.orgId,
                repositoryId: workspaceRepositoryId,
                targetBranch: target.revision.defaultBranch,
                indexingReason: "Mirroring GitHub pull requests",
              },
              {
                error: (error) =>
                  getLogger().error(error, {
                    step: "github-sync-pull-request.ingestion",
                    workspaceId: input.workspaceId,
                  }),
              },
            ),
          )
        return { written: true, path: file.path }
      },
    ),
)
