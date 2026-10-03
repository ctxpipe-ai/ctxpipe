import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { captureGithubPrMirrorTarget } from "../../domain/workspaces/capture-github-pr-mirror.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import {
  captureGithubPullRequests,
  listGithubPullRequestsToBackfill,
} from "../../services/github/pull-request-mirror/sync.js"
import type { GithubPrMirrorFile } from "../../services/github/pull-request-mirror/types.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

/** Pull requests rendered per durable step, so a crash refetches at most one page. */
const PAGE_SIZE = 20

const GithubBackfillPullRequestsInputSchema = z.object({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Normalized URL of the repository that was linked. */
  gitUrl: z.string().min(1),
})

/** Mirror a newly linked repository's recent merged pull requests into the Workspace. */
export const githubBackfillPullRequests = defineWorkflow(
  {
    name: "github-backfill-pull-requests",
    schema: GithubBackfillPullRequestsInputSchema,
  },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "github-backfill-pull-requests",
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        gitUrl: input.gitUrl,
      }),
      async () => {
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
        if ("skipped" in target) return { written: 0, skipped: target.skipped }
        const source = {
          orgId: input.orgId,
          env,
          connectionId: target.source.connectionId,
          repository: target.source.repository,
        }
        const listed = await step.run(
          { name: "list-github-pull-requests" },
          () => listGithubPullRequestsToBackfill(source),
        )
        const files: GithubPrMirrorFile[] = []
        for (let page = 0; page * PAGE_SIZE < listed.numbers.length; page++) {
          const captured = await step.run(
            { name: `mirror-github-pull-requests:${page}` },
            () =>
              captureGithubPullRequests({
                ...source,
                numbers: listed.numbers.slice(
                  page * PAGE_SIZE,
                  (page + 1) * PAGE_SIZE,
                ),
              }),
          )
          files.push(...captured.files)
        }
        if (files.length === 0) return { written: 0 }
        await step.runWorkflow(
          workspaceConnectorMirror.spec,
          {
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            revision: target.revision,
            mirror: target.mirror,
            jobId: `wjob_${run.id}_mirror`,
            files,
            deletePaths: [],
          },
          { name: "commit-github-pr-backfill" },
        )
        const workspaceRepositoryId = target.workspaceRepositoryId
        if (workspaceRepositoryId)
          await step.run({ name: "ingest-github-pull-requests" }, () =>
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
                    step: "github-backfill-pull-requests.ingestion",
                    workspaceId: input.workspaceId,
                  }),
              },
            ),
          )
        return { written: files.length }
      },
    ),
)

/** Called by the link workflow once a link is in the Workspace tree. */
export async function enqueueGithubPrBackfill(input: {
  orgId: string
  workspaceId: string
  gitUrl: string
  /** The link job; one backfill per link command. */
  jobId: string
}): Promise<void> {
  if (!githubRepoFullNameFromWorkspaceUrl(input.gitUrl)) return
  await runWorkflowWithWorkerWake(
    githubBackfillPullRequests.spec,
    {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      gitUrl: input.gitUrl,
    },
    { idempotencyKey: `github-pr-backfill:${input.jobId}` },
  )
}
