import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { stampMirrorFiles } from "../../domain/workspace-sources/stamp-sources.js"
import { getLogger } from "../../observability/logger.js"
import { GITHUB_ISSUES_PREFIX } from "../../services/github/issue-mirror/converter.js"
import {
  captureGithubIssue,
  captureGithubIssuePage,
  GITHUB_ISSUE_BACKFILL_MAX,
} from "../../services/github/issue-mirror/sync.js"
import type { GithubPrMirrorFile } from "../../services/github/pull-request-mirror/types.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runConnectorRepositoryIngestionWorkflow } from "../enqueue-repository-ingestion.js"
import {
  captureGithubMirrorTarget,
  readGithubMirrorStampsToWrite,
} from "./github-sync-pull-request.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const GithubSyncIssueInputSchema = z.object({
  orgId: z.string().min(1),
  /** One run per Workspace that links the repository. */
  workspaceId: z.string().min(1),
  /** Normalized URL of the linked repository. */
  gitUrl: z.string().min(1),
  /** The webhook's installation connection; otherwise the Workspace's. */
  connectionId: z.string().min(1).optional(),
  /** The webhook's issue. Absent: backfill the most recently updated issues. */
  number: z.number().int().positive().optional(),
})

/**
 * Mirror the issues (open and closed) of one linked repository into one
 * Workspace: the webhook's issue, or a backfill of the most recently updated
 * ones. The scope is the link, the same as for pull requests (ADR-031).
 */
export const githubSyncIssue = defineWorkflow(
  {
    logFields: (input) => ({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      gitUrl: input.gitUrl,
    }),
    name: "github-sync-issue",
    schema: GithubSyncIssueInputSchema,
  },
  async ({ input, step, run }) => {
    const target = await step.run(
      { name: "capture-github-issue-mirror-target" },
      () => captureGithubMirrorTarget(input),
    )
    if ("skipped" in target) return { written: 0, skipped: target.skipped }
    const source = {
      orgId: input.orgId,
      env: parseEnv(process.env),
      connectionId: target.connectionId,
      repository: target.repository,
    }
    const files: GithubPrMirrorFile[] = []
    let deletePaths: string[] = []
    if (input.number) {
      const number = input.number
      const captured = await step.run({ name: "mirror-github-issue" }, () =>
        captureGithubIssue({ ...source, number }),
      )
      if ("skipped" in captured)
        return { written: 0, skipped: captured.skipped }
      files.push(...captured.files)
      deletePaths = captured.deletePaths
    } else {
      let after: string | null = null
      let issues = 0
      for (let page = 0; ; page++) {
        const cursor: string | null = after
        const captured: Awaited<ReturnType<typeof captureGithubIssuePage>> =
          await step.run(
            { name: `mirror-github-issues:${page}` },
            (): ReturnType<typeof captureGithubIssuePage> =>
              captureGithubIssuePage({ ...source, after: cursor }),
          )
        if ("skipped" in captured)
          return { written: 0, skipped: captured.skipped }
        files.push(...captured.files)
        issues += captured.issues
        after = captured.nextAfter
        if (!after || issues >= GITHUB_ISSUE_BACKFILL_MAX) break
      }
    }
    const sourcePath = target.sourcePath
    // Stamp each file with the source file of the repository (ADR-050),
    // and restamp from Git the issues of an older stamp.
    const stamped = sourcePath
      ? stampMirrorFiles(
          files,
          sourcePath,
          (
            await step.run({ name: "read-github-issue-mirror-stamps" }, () =>
              readGithubMirrorStampsToWrite({
                orgId: input.orgId,
                workspaceId: input.workspaceId,
                prefix: `${GITHUB_ISSUES_PREFIX}${target.repository}/`,
                sourcePath,
              }),
            )
          ).filter((blob) => !deletePaths.includes(blob.path)),
        )
      : files
    if (stamped.length === 0 && deletePaths.length === 0) return { written: 0 }
    await step.runWorkflow(
      workspaceConnectorMirror.spec,
      {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        revision: target.revision,
        mirror: { provider: "github", gitUrl: input.gitUrl },
        jobId: `wjob_${run.id}_mirror`,
        files: stamped,
        deletePaths,
      },
      { name: "commit-github-issues" },
    )
    if (target.workspaceRepositoryId)
      await runConnectorRepositoryIngestionWorkflow(
        step,
        {
          orgId: input.orgId,
          repositoryId: target.workspaceRepositoryId,
          targetBranch: target.revision.defaultBranch,
          indexingReason: "Mirroring GitHub issues",
        },
        { error: (error) => getLogger().error(error) },
      )
    return { written: stamped.length, deleted: deletePaths.length }
  },
)

/**
 * Hydrate calls this with the new links from `findNewGithubPrBackfillLinks`,
 * after it records their source rows. The key makes replays and a repeated
 * hydrate of the same link start one backfill.
 */
export async function enqueueGithubIssueBackfills(input: {
  orgId: string
  workspaceId: string
  gitUrls: readonly string[]
}): Promise<void> {
  for (const gitUrl of input.gitUrls)
    await runWorkflowWithWorkerWake(
      githubSyncIssue.spec,
      { orgId: input.orgId, workspaceId: input.workspaceId, gitUrl },
      {
        idempotencyKey: `github-issue-backfill:${input.workspaceId}:${gitUrl}`,
      },
    )
}
