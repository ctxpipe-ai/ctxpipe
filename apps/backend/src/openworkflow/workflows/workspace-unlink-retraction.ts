import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import {
  type IngestionPublishPipeline,
  ingestionPublishPipeline,
  ingestionPublishPipelineSchema,
} from "../../domain/ingestion/ingestion-v2-config.js"
import { planUnlinkRetraction } from "../../domain/ingestion/unlink-retraction.js"
import { sourcesHaveNoRepository } from "../../domain/workspace-sources/projection-plan.js"
import { readSourcesTree } from "../../domain/workspace-sources/source-tree.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
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
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { sourceRowsNameRepository } from "../../models/workspace-source-state.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import {
  discardWriteJobPreparedCommit,
  persistBoundWriteJob,
  persistWriteJobPreparedCommit,
} from "../../models/workspace-write-jobs.js"
import {
  persistWriteJobCommitSha,
  persistWriteJobStatus,
} from "../../models/workspaces.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

export const workspaceUnlinkRetractionInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
    /** The source repository that left the sources. */
    retractRepositoryUrl: z.string().min(1),
    /**
     * The publish pipeline when the job was queued. Only ingestion v2 owns
     * files that a retraction can remove (ADR-052 section 3). The step that
     * pushes reads the committed value again: when it does not agree with
     * the plan, the job plans again with the committed value.
     */
    publishPipeline: ingestionPublishPipelineSchema.default("legacy"),
  })
  .strict()
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

/**
 * The host retraction of a repository source that a merged revision removed
 * (CTX-720 on the CTX-710 path). The projection of that revision queues it
 * (`enqueueSourceProjectionFollowUps`). A person approved the removal when
 * they merged it, so the retraction is a direct host commit, as the cleanup
 * of a removed connector source is.
 *
 * - The plan reads the sources at the tip. When a source names the
 *   repository again, or a source file cannot be read, it retracts nothing.
 * - The push step compares the planned pipeline with the committed switch.
 *   When they differ, the job plans again with the committed value (no
 *   retraction under `legacy`).
 * - A lost push race plans again on the new tip. It never goes through the
 *   semantic merge, because that would push the old plan with no new check.
 *
 * `committedPipeline` reads the committed switch at push time; a test gives
 * the value that it checks.
 */
export function defineWorkspaceUnlinkRetractionWorkflow(
  deps: { committedPipeline?: () => IngestionPublishPipeline } = {},
) {
  const committedPipeline = deps.committedPipeline ?? ingestionPublishPipeline
  return defineWorkflow(
    {
      name: "workspace-write-unlink-retraction",
      schema: workspaceUnlinkRetractionInputSchema,
    },
    async ({ input: queuedInput, step, run }) => {
      const input = workspaceUnlinkRetractionInputSchema.parse(queuedInput)
      let planned = input.publishPipeline
      return withWorkspaceWriteContext(
        input,
        "workspace-write-unlink-retraction",
        async () => {
          const env = parseEnv(process.env)
          let revision = input.revision
          const repositoryName = githubRepoFullNameFromWorkspaceUrl(
            revision.remote.url,
          )
          if (!repositoryName || !revision.remote.connectionId)
            throw new Error(
              "Workspace writes require a connected GitHub repository",
            )
          const completed = await completedWorkspaceWrite(
            input,
            "unlink_retraction",
            run.id,
          )
          if (completed) return completed
          await step.run({ name: "claim-command" }, () =>
            persistBoundWriteJob({
              id: input.jobId,
              kind: "unlink_retraction",
              revision: input.revision,
              workflowRunId: run.id,
              publishPipeline: input.publishPipeline,
              retractRepositoryUrl: input.retractRepositoryUrl,
            }),
          )
          // A no-op plan is checked against a fresh tip at most 3 times; a
          // lost push race has its own bound.
          let noOpChecks = 0
          let lostRaces = 0
          while (noOpChecks < 3) {
            let acquired: NonNullable<
              Awaited<ReturnType<typeof acquireWorkspaceWriteRevision>>
            >
            for (;;) {
              const candidate = await step.run(
                { name: "acquire-revision" },
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
            const pipeline = planned
            const changes = await step.run(
              { name: "transform-unlink-retraction" },
              async () => {
                const none: Awaited<ReturnType<typeof planUnlinkRetraction>> = {
                  files: [],
                  deletePaths: [],
                }
                if (pipeline !== "v2") return none
                // The CTX-710 fence: a repository that a source names again
                // keeps its files, also when that entry is invalid for now.
                // The tip text gives an invalid entry no scope, so a stored
                // row that still holds the repository also keeps it.
                const { sourcesFile, sourceFiles } = await readSourcesTree(
                  acquired.pack,
                )
                if (
                  !(await sourcesHaveNoRepository(
                    { text: sourcesFile, sourceFiles },
                    input.retractRepositoryUrl,
                  )) ||
                  sourceRowsNameRepository(
                    await listWorkspaceSourceRows(input),
                    input.retractRepositoryUrl,
                  )
                )
                  return none
                return planUnlinkRetraction({
                  pack: acquired.pack,
                  sourceUrl: input.retractRepositoryUrl,
                  workspaceRepositoryUrl: revision.remote.url,
                  observedAt: new Date(run.createdAt).toISOString(),
                })
              },
            )
            const changedPaths = [
              ...changes.files.map((file) => file.path),
              ...changes.deletePaths,
            ]
            if (!changedPaths.length) {
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
              }
            }
            const staged = await step.run({ name: "stage" }, () =>
              stageGitFiles(acquired.pack, changes.files, changes.deletePaths),
            )
            await step.run({ name: "validate" }, () =>
              validateGitTree(staged, changedPaths),
            )
            const subject = await step.run({ name: "commit-subject" }, () =>
              generateCommitSubject({
                repoName: repositoryName.split("/")[1] ?? repositoryName,
                trigger: "unlink_retraction",
                fileNames: changedPaths,
              }),
            )
            const committed = await step.run({ name: "commit" }, async () => {
              const pack = await commitGitTree(staged, {
                subject,
                createdAt: run.createdAt,
              })
              await persistWriteJobPreparedCommit(input.jobId, pack.sha)
              return pack
            })
            let pushed:
              | Awaited<ReturnType<typeof attemptWorkspaceCommit>>
              | undefined
            for (;;) {
              const attempt = await step.run(
                { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
                async () => {
                  // The same step reads the switch and pushes, so no step
                  // runs between the check and the push.
                  const committedValue = committedPipeline()
                  if (committedValue !== pipeline)
                    return { replan: committedValue }
                  return attemptWorkspaceCommit(input, revision, committed, env)
                },
              )
              if ("replan" in attempt) {
                planned = attempt.replan
                // An earlier pause result must not survive a replan.
                pushed = undefined
                break
              }
              pushed = attempt
              if (pushed.pushed || pushed.reason !== "paused") break
              await step.run({ name: "pause-push" }, () =>
                persistWriteJobStatus(input.jobId, "paused"),
              )
              await step.sleep("await-default-write-access", "1 minute")
              await step.run({ name: "resume-push" }, () =>
                persistWriteJobStatus(input.jobId, "running"),
              )
            }
            if (!pushed?.pushed) {
              // The switch changed, or the default branch moved: plan again.
              await step.run({ name: "discard-unpublished-candidate" }, () =>
                discardWriteJobPreparedCommit(input.jobId, committed.sha),
              )
              if (pushed)
                revision = await step.run(
                  { name: "refresh-raced-revision" },
                  () => refreshWorkspaceWriteRevision(input, revision, env),
                )
              if (++lostRaces > 5)
                throw new Error(
                  "Default branch or publish pipeline kept changing during the retraction push",
                )
              continue
            }
            const published = await step.run({ name: "publish-result" }, () =>
              publishWorkspaceWriteRevision(input, revision, committed, env),
            )
            await step.run({ name: "enqueue-hydrate" }, async () => {
              await runWorkflowWithWorkerWake(
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
              persistWriteJobCommitSha(input.jobId, committed.sha),
            )
            return { committed: true as const, commitSha: committed.sha }
          }
          throw new Error(
            "Default branch kept changing during no-op validation",
          )
        },
      )
    },
  )
}

export const workspaceUnlinkRetraction =
  defineWorkspaceUnlinkRetractionWorkflow()
