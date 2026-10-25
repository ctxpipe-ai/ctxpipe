import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import type { GithubMirrorFile } from "../../services/github/github-mirror.js"
import { GITHUB_ISSUES_PREFIX } from "../../services/github/issue-mirror/converter.js"
import {
  captureGithubIssue,
  captureGithubIssuePage,
  GITHUB_ISSUE_BACKFILL_MAX,
} from "../../services/github/issue-mirror/sync.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import {
  captureGithubMirrorTarget,
  commitGithubMirror,
} from "../github-mirror-steps.js"

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
    const files: GithubMirrorFile[] = []
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
    const written = await commitGithubMirror(step, {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      gitUrl: input.gitUrl,
      runId: run.id,
      target,
      files,
      deletePaths,
      prefix: `${GITHUB_ISSUES_PREFIX}${target.repository}/`,
      reason: "Mirroring GitHub issues",
      stepNames: {
        readStamps: "read-github-issue-mirror-stamps",
        commit: "commit-github-issues",
      },
    })
    if (written === 0 && deletePaths.length === 0) return { written: 0 }
    return { written, deleted: deletePaths.length }
  },
)

/**
 * Start one backfill per link. Hydrate calls this with the new links from
 * `findNewGithubPrBackfillLinks`, after it records their source rows; the key
 * makes replays and a repeated hydrate of the same link start one backfill.
 * An installation that accepts the Issues permission later calls it with the
 * webhook delivery id in the key, so that the link gets one more backfill.
 */
export async function enqueueGithubIssueBackfills(input: {
  orgId: string
  workspaceId: string
  gitUrls: readonly string[]
  /** The installation connection that reads the repositories. */
  connectionId?: string
  deliveryId?: string
}): Promise<void> {
  for (const gitUrl of input.gitUrls)
    await runWorkflowWithWorkerWake(
      githubSyncIssue.spec,
      {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        gitUrl,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      },
      {
        idempotencyKey: [
          "github-issue-backfill",
          input.workspaceId,
          gitUrl,
          ...(input.deliveryId ? [input.deliveryId] : []),
        ].join(":"),
      },
    )
}
