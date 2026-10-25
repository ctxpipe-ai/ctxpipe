import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { listOrgLinkedRepositories } from "../../models/workspaces.js"
import type { GithubMirrorFile } from "../../services/github/github-mirror.js"
import { GITHUB_PR_PULLS_PREFIX } from "../../services/github/pull-request-mirror/converter.js"
import { shouldMirrorGithubPullRequest } from "../../services/github/pull-request-mirror/policy.js"
import {
  captureClosedGithubPullRequestPage,
  captureGithubPullRequests,
  GITHUB_PR_BACKFILL_MAX,
} from "../../services/github/pull-request-mirror/sync.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import {
  captureGithubMirrorTarget,
  commitGithubMirror,
} from "../github-mirror-steps.js"

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

/**
 * Mirror closed pull requests (merged or not) of one linked repository into
 * one Workspace: the webhook's pull requests, or a backfill of the newest closed ones.
 */
export const githubSyncPullRequest = defineWorkflow(
  {
    logFields: (input) => ({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      gitUrl: input.gitUrl,
    }),
    name: "github-sync-pull-request",
    schema: GithubSyncPullRequestInputSchema,
  },
  async ({ input, step, run }) => {
    if (input.candidate && !shouldMirrorGithubPullRequest(input.candidate))
      return { written: 0, skipped: "policy" as const }
    const target = await step.run(
      { name: "capture-github-pr-mirror-target" },
      () => captureGithubMirrorTarget(input),
    )
    if ("skipped" in target) return { written: 0, skipped: target.skipped }
    const source = {
      orgId: input.orgId,
      env: parseEnv(process.env),
      connectionId: target.connectionId,
      repository: target.repository,
    }
    const files: GithubMirrorFile[] = []
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
    const written = await commitGithubMirror(step, {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      gitUrl: input.gitUrl,
      runId: run.id,
      target,
      files,
      deletePaths: [],
      prefix: `${GITHUB_PR_PULLS_PREFIX}${target.repository}/`,
      reason: "Mirroring GitHub pull requests",
      stepNames: {
        readStamps: "read-github-pr-mirror-stamps",
        commit: "commit-github-pull-requests",
      },
    })
    return { written }
  },
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
