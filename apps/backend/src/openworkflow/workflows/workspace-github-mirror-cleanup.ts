import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { planGithubMirrorCleanup } from "../../domain/workspaces/github-mirror-cleanup.js"
import { workspaceGitRead } from "../../domain/workspaces/resolve-revision.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  attemptWorkspaceCommit,
  publishWorkspaceWriteRevision,
  refreshWorkspaceWriteRevision,
} from "../../domain/workspaces/write-broker.js"
import {
  acquireWorkspaceWriteRevision,
  completedWorkspaceWrite,
  completeWorkspaceWrite,
  prepareWorkspaceWriteCommit,
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  discardWriteJobPreparedCommit,
  persistBoundWriteJob,
} from "../../models/workspace-write-jobs.js"
import { persistWriteJobStatus } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { enqueueWorkflow } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runJobRefStep } from "../write-steps.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

const inputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
  })
  .strict()
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

/**
 * The one-time cleanup of the GitHub pull request and issue mirrors of one
 * Workspace (CTX-1693): one direct host commit through the write broker.
 * Only an operator queues it (`src/scripts/cleanupGithubMirrors.ts --apply`).
 *
 * - The plan reads the tree that the push lands on: the push lands only on
 *   that parent. Thus the sources that keep a mirror are the sources of the
 *   commit.
 * - A lost push race plans again on the new tip. It never goes through the
 *   semantic merge, because that would push the old plan with no new check.
 * - The log and the result hold counts only, no repository and no file.
 */
export const workspaceGithubMirrorCleanup = defineWorkflow(
  { name: "workspace-write-github-mirror-cleanup", schema: inputSchema },
  async ({ input: queuedInput, step, run }) => {
    const input = inputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-github-mirror-cleanup",
      async () => {
        const env = parseEnv(process.env)
        // Read access to the bound repository, from the workflow input (CTX-955).
        const read = workspaceGitRead({
          orgId: input.orgId,
          env,
          remote: input.revision.remote,
        })
        let revision = input.revision
        if (
          !githubRepoFullNameFromWorkspaceUrl(revision.remote.url) ||
          !revision.remote.connectionId
        )
          throw new Error(
            "Workspace writes require a connected GitHub repository",
          )
        const completed = await completedWorkspaceWrite(
          input,
          "github_mirror_cleanup",
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: "github_mirror_cleanup",
            revision: input.revision,
            workflowRunId: run.id,
          }),
        )
        let noOpChecks = 0
        let lostRaces = 0
        while (noOpChecks < 3) {
          let acquired: NonNullable<
            Awaited<ReturnType<typeof acquireWorkspaceWriteRevision>>
          >
          for (;;) {
            const candidate = await step.run(
              { name: "acquire-revision-v2" },
              () => acquireWorkspaceWriteRevision(input, revision, env),
            )
            if (candidate) {
              acquired = candidate
              break
            }
            await step.run({ name: "pause-command" }, () =>
              persistWriteJobStatus(input.jobId, "paused"),
            )
            await step.sleep("await-write-access", "1 minute")
            await step.run({ name: "resume-command" }, () =>
              persistWriteJobStatus(input.jobId, "running"),
            )
          }
          // One step makes the change, commits it, and pushes the commit to
          // its job ref: no step output holds a file (CTX-1239).
          const committed = await runJobRefStep(
            step,
            input.jobId,
            { name: "prepare-commit" },
            () =>
              prepareWorkspaceWriteCommit(
                input,
                revision,
                acquired.pack,
                {
                  change: async () => {
                    const plan = await planGithubMirrorCleanup({
                      orgId: input.orgId,
                      workspaceId: input.workspaceId,
                      pack: acquired.pack,
                      read,
                    })
                    getLogger().info("github_mirror_cleanup.plan", {
                      workspaceId: input.workspaceId,
                      jobId: input.jobId,
                      ...plan.counts,
                    })
                    return { files: plan.files, deletePaths: plan.deletePaths }
                  },
                  subject:
                    "ctxpipe - Clean up the GitHub pull request and issue mirrors",
                  createdAt: run.createdAt,
                },
                env,
              ),
          )
          if (!committed) {
            const refreshed = await step.run({ name: "confirm-no-op" }, () =>
              refreshWorkspaceWriteRevision(input, revision, env),
            )
            if (!sameWorkspaceRevision(refreshed, revision)) {
              revision = refreshed
              noOpChecks++
              continue
            }
            await step.run({ name: "complete-no-op" }, () =>
              persistWriteJobStatus(input.jobId, "completed"),
            )
            return { committed: false as const, reason: "no_changes" as const }
          }
          let pushed: Awaited<ReturnType<typeof attemptWorkspaceCommit>>
          for (;;) {
            pushed = await step.run(
              { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
              () => attemptWorkspaceCommit(input, revision, committed, env),
            )
            if (pushed.pushed || pushed.reason !== "paused") break
            await step.run({ name: "pause-push" }, () =>
              persistWriteJobStatus(input.jobId, "paused"),
            )
            await step.sleep("await-default-write-access", "1 minute")
            await step.run({ name: "resume-push" }, () =>
              persistWriteJobStatus(input.jobId, "running"),
            )
          }
          if (!pushed.pushed) {
            // The default branch moved: plan again on the new tip.
            await step.run({ name: "discard-unpublished-candidate" }, () =>
              discardWriteJobPreparedCommit(input.jobId, committed.sha),
            )
            revision = await step.run({ name: "refresh-raced-revision" }, () =>
              refreshWorkspaceWriteRevision(input, revision, env),
            )
            if (++lostRaces > 5)
              throw new Error(
                "Default branch kept changing during the mirror cleanup push",
              )
            continue
          }
          const published = await step.run({ name: "publish-result" }, () =>
            publishWorkspaceWriteRevision(input, revision, committed, env),
          )
          await step.run({ name: "enqueue-hydrate" }, async () => {
            await enqueueWorkflow(
              workspaceHydrate.spec,
              {
                orgId: input.orgId,
                workspaceId: input.workspaceId,
                revision: published,
              },
              { idempotencyKey: `${input.jobId}:hydrate` },
            )
          })
          await step.run({ name: "complete" }, () =>
            completeWorkspaceWrite(
              { ...input, remote: input.revision.remote },
              committed.sha,
              env,
            ),
          )
          return { committed: true as const, commitSha: committed.sha }
        }
        throw new Error("Default branch kept changing during no-op validation")
      },
    )
  },
)
