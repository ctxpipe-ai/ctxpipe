import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { githubSourcePathOf } from "../../domain/workspace-sources/github-sources.js"
import { stampMirrorFiles } from "../../domain/workspace-sources/stamp-sources.js"
import { readWorkspaceBlobs } from "../../domain/workspace-sources/write-slice.js"
import { resolveWorkspaceReadRevision } from "../../domain/workspaces/resolve-revision.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { findRepositoriesByNormalizedGitUrls } from "../../models/repositories.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { listOrgLinkedRepositories } from "../../models/workspaces.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { GITHUB_PR_PULLS_PREFIX } from "../../services/github/pull-request-mirror/converter.js"
import { shouldMirrorGithubPullRequest } from "../../services/github/pull-request-mirror/policy.js"
import {
  captureClosedGithubPullRequestPage,
  captureGithubPullRequests,
  GITHUB_PR_BACKFILL_MAX,
} from "../../services/github/pull-request-mirror/sync.js"
import type { GithubPrMirrorFile } from "../../services/github/pull-request-mirror/types.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runConnectorRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const GithubSyncPullRequestCandidateSchema = z.object({
  state: z.enum(["open", "closed"]),
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
  /** Normalized URL of the linked repository. */
  gitUrl: z.string().min(1),
  /** The webhook's installation connection; otherwise the Workspace's. */
  connectionId: z.string().min(1).optional(),
  /** Webhook pull requests. Absent: backfill the newest closed ones. */
  numbers: z.array(z.number().int().positive()).min(1).optional(),
  /** Webhook-provided facts; when present the policy runs before any I/O. */
  candidate: GithubSyncPullRequestCandidateSchema.optional(),
})

/** Revision to write, the connection that reads the repository, and the row to re-index. */
async function captureTarget(input: {
  orgId: string
  workspaceId: string
  gitUrl: string
  connectionId?: string
}) {
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: input.orgId } },
  })
  if (!org) throw new Error("Organization not found")
  return withOrgIdContext(org, async () => {
    const resolved = await resolveWorkspaceReadRevision({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      env: parseEnv(process.env),
      refresh: true,
    })
    if (!resolved) return { skipped: "no_revision" as const }
    const revision = { ...resolved.revision, access: "write-default" as const }
    const connectionId = input.connectionId ?? revision.remote.connectionId
    const repository = githubRepoFullNameFromWorkspaceUrl(input.gitUrl)
    if (!connectionId || !repository) {
      getLogger().warn("github_pr_mirror_no_source", {
        workspaceId: input.workspaceId,
        gitUrl: input.gitUrl,
      })
      return { skipped: "no_source" as const }
    }
    const [workspaceRepository] = await findRepositoriesByNormalizedGitUrls([
      revision.remote.url,
    ])
    const sourcePath = githubSourcePathOf(
      await listWorkspaceSourceRows({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
      }),
      input.gitUrl,
    )
    return {
      revision,
      connectionId,
      repository,
      /** The GitHub source file of the repository; stamped into each file. */
      sourcePath,
      /** The Workspace repository's org row, re-indexed after a mirror commit. */
      workspaceRepositoryId: workspaceRepository?.id ?? null,
    }
  })
}

/** The mirror files of the repository with a wrong or missing stamp. */
async function readStampsToWrite(input: {
  orgId: string
  workspaceId: string
  repository: string
  sourcePath: string
}) {
  const blobs = await readWorkspaceBlobs({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    env: parseEnv(process.env),
    owners: [
      {
        prefixes: [`${GITHUB_PR_PULLS_PREFIX}${input.repository}/`],
        sourcePath: input.sourcePath,
      },
    ],
  })
  return blobs.filter((blob) => blob.restamped !== undefined)
}

/**
 * Mirror closed pull requests (merged or not) of one linked repository into
 * one Workspace: the webhook's pull requests, or a backfill of the newest closed ones.
 */
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
      }),
      async () => {
        if (input.candidate && !shouldMirrorGithubPullRequest(input.candidate))
          return { written: 0, skipped: "policy" as const }
        const target = await step.run(
          { name: "capture-github-pr-mirror-target" },
          () => captureTarget(input),
        )
        if ("skipped" in target) return { written: 0, skipped: target.skipped }
        const source = {
          orgId: input.orgId,
          env: parseEnv(process.env),
          connectionId: target.connectionId,
          repository: target.repository,
        }
        const files: GithubPrMirrorFile[] = []
        if (input.numbers) {
          const numbers = input.numbers
          const captured = await step.run(
            { name: "mirror-github-pull-requests" },
            () => captureGithubPullRequests({ ...source, numbers }),
          )
          files.push(...captured.files)
        } else {
          let after: string | null = null
          let pulls = 0
          for (let page = 0; ; page++) {
            const cursor: string | null = after
            const captured: Awaited<
              ReturnType<typeof captureClosedGithubPullRequestPage>
            > = await step.run(
              { name: `mirror-github-pull-requests:${page}` },
              () =>
                captureClosedGithubPullRequestPage({
                  ...source,
                  after: cursor,
                }),
            )
            files.push(...captured.files)
            pulls += captured.pulls
            after = captured.nextAfter
            if (!after || pulls >= GITHUB_PR_BACKFILL_MAX) break
          }
        }
        const sourcePath = target.sourcePath
        // Stamp each file with the source file of the repository (ADR-050),
        // and restamp from Git the closed pull requests of an older stamp.
        const stamped = sourcePath
          ? stampMirrorFiles(
              files,
              sourcePath,
              await step.run({ name: "read-github-pr-mirror-stamps" }, () =>
                readStampsToWrite({
                  orgId: input.orgId,
                  workspaceId: input.workspaceId,
                  repository: target.repository,
                  sourcePath,
                }),
              ),
            )
          : files
        if (stamped.length === 0) return { written: 0 }
        await step.runWorkflow(
          workspaceConnectorMirror.spec,
          {
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            revision: target.revision,
            mirror: { provider: "github", gitUrl: input.gitUrl },
            jobId: `wjob_${run.id}_mirror`,
            files: stamped,
            deletePaths: [],
          },
          { name: "commit-github-pull-requests" },
        )
        if (target.workspaceRepositoryId)
          await runConnectorRepositoryIngestionWorkflow(
            step,
            {
              orgId: input.orgId,
              repositoryId: target.workspaceRepositoryId,
              targetBranch: target.revision.defaultBranch,
              indexingReason: "Mirroring GitHub pull requests",
            },
            { error: (error) => getLogger().error(error) },
          )
        return { written: stamped.length }
      },
    ),
)

/**
 * Hydrate calls this with a revision's linked repositories before it records
 * them. It returns each GitHub repository that is not yet in the Workspace's
 * linked table. Each one needs one backfill.
 */
export async function findNewGithubPrBackfillLinks(input: {
  orgId: string
  workspaceId: string
  workspaceUrl: string
  gitUrls: readonly string[]
}): Promise<string[]> {
  const known = new Set([
    normalizeWorkspaceRepositoryUrl(input.workspaceUrl),
    ...(await listOrgLinkedRepositories(input.orgId))
      .filter((row) => row.workspaceId === input.workspaceId)
      .map((row) => normalizeWorkspaceRepositoryUrl(row.gitUrl)),
  ])
  return [
    ...new Set(input.gitUrls.map(normalizeWorkspaceRepositoryUrl)),
  ].filter(
    (gitUrl) =>
      !known.has(gitUrl) && githubRepoFullNameFromWorkspaceUrl(gitUrl),
  )
}

/**
 * Hydrate calls this after it records the source rows of the links from
 * {@link findNewGithubPrBackfillLinks}. A backfill reads the source file of its
 * repository from those rows to stamp each file. The key makes replays and a
 * repeated hydrate of the same link start it once.
 */
export async function enqueueGithubPrBackfills(input: {
  orgId: string
  workspaceId: string
  gitUrls: readonly string[]
}): Promise<void> {
  for (const gitUrl of input.gitUrls)
    await runWorkflowWithWorkerWake(
      githubSyncPullRequest.spec,
      { orgId: input.orgId, workspaceId: input.workspaceId, gitUrl },
      { idempotencyKey: `github-pr-backfill:${input.workspaceId}:${gitUrl}` },
    )
}
