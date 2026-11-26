import type { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { workspaceGitRead } from "../../domain/workspaces/resolve-revision.js"
import {
  sameWorkspaceRevision,
  type WorkspaceRevision,
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
import type { GitFileChange } from "../../services/git/file-change.js"
import type { GitPack, GitRemoteRead } from "../../services/git/pack.js"
import { enqueueWorkflow } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runJobRefStep } from "../write-steps.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

type HostWriteInput = {
  orgId: string
  workspaceId: string
  jobId: string
  revision: WorkspaceRevision
}

/**
 * One direct host commit through the write broker that plans its change on
 * the tree that the push lands on. The unlink retraction and the GitHub
 * mirror cleanup use it.
 *
 * - `change` reads the acquired tree. The push lands only on that parent,
 *   so the plan is checked against the commit that it changes.
 * - A lost push race plans again on the new tip. It never goes through the
 *   semantic merge, because that would push the old plan with no new check.
 * - A no-op plan is checked against a fresh tip at most 3 times; a lost push
 *   race has its own bound.
 *
 * The step names stay fixed, so a replay finds its steps.
 */
export function defineReplanningHostWriteWorkflow<
  S extends z.ZodType<HostWriteInput>,
  Extra extends Record<string, unknown>,
>(options: {
  name: string
  kind: "unlink_retraction" | "github_mirror_cleanup"
  schema: S
  /** The kind-specific fields of the job row. */
  claim?: (
    input: z.output<S>,
  ) => Partial<Parameters<typeof persistBoundWriteJob>[0]>
  change: (
    input: z.output<S>,
    tree: {
      pack: GitPack
      read: GitRemoteRead
      revision: WorkspaceRevision
      createdAt: Date | string
    },
  ) => Promise<{ files: GitFileChange[]; deletePaths: string[] }>
  subject: string | { trigger: string }
  /** The kind-specific fields of each result. */
  result?: (input: z.output<S>) => Promise<Extra>
}) {
  return defineWorkflow(
    { name: options.name, schema: options.schema },
    async ({ input: queuedInput, step, run }) => {
      const input: z.output<S> = options.schema.parse(queuedInput)
      const extra = async () =>
        options.result ? await options.result(input) : ({} as Extra)
      return withWorkspaceWriteContext(input, options.name, async () => {
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
          options.kind,
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: options.kind,
            revision: input.revision,
            workflowRunId: run.id,
            ...options.claim?.(input),
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
                  change: () =>
                    options.change(input, {
                      pack: acquired.pack,
                      read,
                      revision,
                      createdAt: run.createdAt,
                    }),
                  subject: options.subject,
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
            return {
              committed: false as const,
              reason: "no_changes" as const,
              ...(await extra()),
            }
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
                `Default branch kept changing during the ${options.kind} push`,
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
          return {
            committed: true as const,
            commitSha: committed.sha,
            ...(await extra()),
          }
        }
        throw new Error("Default branch kept changing during no-op validation")
      })
    },
  )
}
