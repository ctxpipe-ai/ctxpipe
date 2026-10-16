import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import {
  retiredPublishPipelineField,
  workspacePublishPipeline,
} from "../../domain/ingestion/ingestion-v2-config.js"
import { planUnlinkRetraction } from "../../domain/ingestion/unlink-retraction.js"
import { sourcesHaveNoRepository } from "../../domain/workspace-sources/projection-plan.js"
import { checkSourcePath } from "../../domain/workspace-sources/source-file.js"
import { readSourcesTree } from "../../domain/workspace-sources/source-tree.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import { packWorkspaceFormat } from "../../domain/workspaces/workspace-format-tree.js"
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
import { getLogger } from "../../observability/logger.js"
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
     * The source file of that repository that the merged revision removed
     * (ADR-050 revision 2026-10-16). The files of the repository list it in
     * `sources`.
     */
    retractSourcePath: z
      .string()
      .refine((path) => checkSourcePath(path).ok, "Use a source file path"),
    /** Retired: a job that was queued with it still parses. */
    publishPipeline: retiredPublishPipelineField,
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
 * - Only ingestion v2 owns files that a retraction can remove (ADR-052
 *   section 3), so the plan retracts nothing on a tree below format 3
 *   (ADR-052 phase 4, G5). The plan reads the tree that the push lands on:
 *   the push lands only on that parent.
 * - A lost push race plans again on the new tip. It never goes through the
 *   semantic merge, because that would push the old plan with no new check.
 */
export function defineWorkspaceUnlinkRetractionWorkflow() {
  return defineWorkflow(
    {
      name: "workspace-write-unlink-retraction",
      schema: workspaceUnlinkRetractionInputSchema,
    },
    async ({ input: queuedInput, step, run }) => {
      const input = workspaceUnlinkRetractionInputSchema.parse(queuedInput)
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
              retractRepositoryUrl: input.retractRepositoryUrl,
              retractSourcePath: input.retractSourcePath,
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
            const changes = await step.run(
              { name: "transform-unlink-retraction" },
              async () => {
                const none: Awaited<ReturnType<typeof planUnlinkRetraction>> = {
                  files: [],
                  deletePaths: [],
                  skipped: [],
                }
                if (
                  workspacePublishPipeline(
                    await packWorkspaceFormat(acquired.pack),
                  ) !== "v2"
                )
                  return none
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
                const plan = await planUnlinkRetraction({
                  pack: acquired.pack,
                  sourceUrl: input.retractRepositoryUrl,
                  sourcePath: input.retractSourcePath,
                  workspaceRepositoryUrl: revision.remote.url,
                  observedAt: new Date(run.createdAt).toISOString(),
                })
                // A file that the validator cannot delete stays. The job
                // result lists it, so the retraction does not fail forever.
                if (plan.skipped.length)
                  getLogger().warn(
                    "The unlink retraction left files outside the allowed knowledge folders unchanged",
                    {
                      workspaceId: input.workspaceId,
                      jobId: input.jobId,
                      skipped: plan.skipped,
                    },
                  )
                return plan
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
                skipped: changes.skipped,
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
              // The default branch moved: plan again on the new tip, and
              // read its format again.
              await step.run({ name: "discard-unpublished-candidate" }, () =>
                discardWriteJobPreparedCommit(input.jobId, committed.sha),
              )
              revision = await step.run(
                { name: "refresh-raced-revision" },
                () => refreshWorkspaceWriteRevision(input, revision, env),
              )
              if (++lostRaces > 5)
                throw new Error(
                  "Default branch kept changing during the retraction push",
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
            return {
              committed: true as const,
              commitSha: committed.sha,
              skipped: changes.skipped,
            }
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
