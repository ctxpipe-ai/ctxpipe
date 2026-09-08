import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import {
  connectorMirrorContentSchema,
  connectorMirrorSourceSchema,
} from "../../domain/workspaces/connector-mirror.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  createMergeSandbox,
  destroyMergeSandbox,
  planMergeSandbox,
  resolveSemanticConflicts,
} from "../../domain/workspaces/semantic-merge.js"
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
import {
  discardWriteJobPreparedCommit,
  persistBoundWriteJob,
  persistWriteJobPreparedCommit,
  validateSemanticHandoff,
} from "../../models/workspace-write-jobs.js"
import {
  persistWriteJobCommitSha,
  persistWriteJobStatus,
} from "../../models/workspaces.js"
import {
  gitFileChangeSchema,
  repositoryFilePathSchema,
} from "../../services/git/file-change.js"
import {
  mergeGitFiles,
  resolveGitMergeTree,
} from "../../services/git/merge-tree.js"
import {
  commitGitTree,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { workspaceHydrate } from "./workspace-hydrate.js"
import { workspaceSemanticCleanup } from "./workspace-semantic-cleanup.js"

export const semanticMergeContentSchema = z
  .object({
    mirror: connectorMirrorSourceSchema.optional(),
    previousSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    files: z.array(gitFileChangeSchema),
    deletePaths: z.array(repositoryFilePathSchema),
  })
  .strict()
  .refine((input) => {
    const paths = [
      ...input.files.map((file) => file.path),
      ...input.deletePaths,
    ]
    return new Set(paths).size === paths.length
  }, "Each path must have exactly one operation")
  .refine(
    (input) =>
      !input.mirror ||
      connectorMirrorContentSchema.safeParse({
        mirror: input.mirror,
        files: input.files,
        deletePaths: input.deletePaths,
      }).success,
    "Connector handoff must retain its managed paths",
  )

export const workspaceSemanticMergeInputSchema = semanticMergeContentSchema
  .safeExtend({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
    handoff: z
      .object({
        ownerRunId: z.string().min(1),
        candidateSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      })
      .strict()
      .optional(),
  })
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

export const workspaceSemanticMerge = defineWorkflow(
  {
    name: "workspace-write-semantic-merge",
    schema: workspaceSemanticMergeInputSchema,
  },
  async ({ input: queuedInput, step, run }) => {
    const input = workspaceSemanticMergeInputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-semantic-merge",
      async () => {
        const env = parseEnv(process.env)
        let revision = input.revision
        const repositoryName = githubRepoFullNameFromWorkspaceUrl(
          revision.remote.url,
        )
        const connectionId = revision.remote.connectionId
        if (!repositoryName || !connectionId)
          throw new Error(
            "Workspace writes require a connected GitHub repository",
          )
        const completed = input.handoff
          ? await validateSemanticHandoff({ ...input, handoff: input.handoff })
          : await completedWorkspaceWrite(input, "semantic_merge", run.id)
        if (completed) return completed
        if (!input.handoff)
          await step.run({ name: "claim-command" }, () =>
            persistBoundWriteJob({
              id: input.jobId,
              kind: "semantic_merge",
              mirror: input.mirror,
              revision: input.revision,
              workflowRunId: run.id,
              previousSha: input.previousSha,
              files: input.files,
              deletePaths: input.deletePaths,
            }),
          )
        for (let refreshAttempt = 0; refreshAttempt < 3; refreshAttempt++) {
          let acquired: NonNullable<
            Awaited<ReturnType<typeof acquireWorkspaceWriteRevision>>
          >
          for (;;) {
            const candidate = await step.run(
              { name: "acquire-revision", retryPolicy: { maximumAttempts: 3 } },
              () =>
                acquireWorkspaceWriteRevision(
                  input,
                  revision,
                  env,
                  input.previousSha,
                ),
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
          const merged = await step.run(
            { name: "transform-semantic-merge" },
            () =>
              mergeGitFiles({
                pack: acquired.pack,
                previousSha: input.previousSha,
                files: input.files,
                deletePaths: input.deletePaths,
              }),
          )
          if (!merged) {
            const refreshed = await step.run({ name: "confirm-no-op" }, () =>
              refreshWorkspaceWriteRevision(input, revision, env),
            )
            if (!sameWorkspaceRevision(refreshed, revision)) {
              revision = refreshed
              continue
            }
            await step.run({ name: "enqueue-no-op-hydrate" }, () =>
              runWorkflowWithWorkerWake(
                workspaceHydrate.spec,
                {
                  orgId: input.orgId,
                  workspaceId: input.workspaceId,
                  revision,
                },
                { idempotencyKey: `${input.jobId}:hydrate` },
              ),
            )
            if (!input.handoff)
              await step.run({ name: "complete-no-op" }, () =>
                persistWriteJobStatus(input.jobId, "completed"),
              )
            return {
              committed: false as const,
              reason: "no_changes" as const,
            }
          }
          const resolved = merged.conflicts.length
            ? await (async () => {
                const planned = await step.run(
                  { name: "plan-merge-sandbox" },
                  () => planMergeSandbox(`${run.id}:${refreshAttempt}`),
                )
                const locator = await step.run(
                  { name: "bound-resource-deadline" },
                  () => ({
                    ...planned,
                    // An in-flight pre-upgrade plan has no deadline yet.
                    expiresAt:
                      planned.expiresAt ??
                      new Date(
                        new Date(run.createdAt).getTime() + 120_000,
                      ).toISOString(),
                  }),
                )
                await step.run(
                  { name: "schedule-resource-cleanup" },
                  async () => {
                    await runWorkflowWithWorkerWake(
                      workspaceSemanticCleanup.spec,
                      {
                        orgId: input.orgId,
                        workspaceId: input.workspaceId,
                        locator,
                      },
                      {
                        availableAt: new Date(locator.expiresAt),
                        idempotencyKey: `${run.id}:${refreshAttempt}:cleanup`,
                      },
                    )
                  },
                )
                const sandbox = await step.run(
                  { name: "create-merge-sandbox" },
                  () => createMergeSandbox(locator),
                )
                try {
                  return await step.run(
                    {
                      name: "resolve-semantic-conflicts",
                      retryPolicy: { maximumAttempts: 3 },
                    },
                    () => resolveSemanticConflicts(sandbox, merged.conflicts),
                  )
                } finally {
                  await step.run({ name: "destroy-merge-sandbox" }, () =>
                    destroyMergeSandbox(sandbox),
                  )
                }
              })()
            : null
          const staged = await step.run({ name: "stage" }, () =>
            resolved ? resolveGitMergeTree(merged, resolved) : merged.staged,
          )
          const changed = await step.run({ name: "validate" }, () =>
            validateGitTree(staged, merged.paths, { allowNoChanges: true }),
          )
          if (!changed.length) {
            const refreshed = await step.run(
              { name: "confirm-resolved-no-op" },
              () => refreshWorkspaceWriteRevision(input, revision, env),
            )
            if (!sameWorkspaceRevision(refreshed, revision)) {
              revision = refreshed
              continue
            }
            await step.run({ name: "enqueue-resolved-no-op-hydrate" }, () =>
              runWorkflowWithWorkerWake(
                workspaceHydrate.spec,
                {
                  orgId: input.orgId,
                  workspaceId: input.workspaceId,
                  revision,
                },
                { idempotencyKey: `${input.jobId}:hydrate` },
              ),
            )
            if (!input.handoff)
              await step.run({ name: "complete-resolved-no-op" }, () =>
                persistWriteJobCommitSha(input.jobId, null),
              )
            return { committed: false as const, reason: "no_changes" as const }
          }
          const subject = await step.run({ name: "commit-subject" }, () =>
            generateCommitSubject({
              repoName: repositoryName.split("/")[1] ?? repositoryName,
              trigger: "semantic_merge",
              fileNames: changed,
            }),
          )
          const committed = await step.run({ name: "commit" }, async () => {
            const pack = await commitGitTree(staged, {
              subject,
              createdAt: run.createdAt,
            })
            if (input.handoff)
              await validateSemanticHandoff(
                { ...input, handoff: input.handoff },
                pack.sha,
              )
            else await persistWriteJobPreparedCommit(input.jobId, pack.sha)
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
            await step.run({ name: "discard-unpublished-candidate" }, () =>
              discardWriteJobPreparedCommit(input.jobId, committed.sha),
            )
            revision = await step.run({ name: "refresh-raced-revision" }, () =>
              refreshWorkspaceWriteRevision(input, revision, env),
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
          if (!input.handoff)
            await step.run({ name: "complete" }, () =>
              persistWriteJobCommitSha(input.jobId, committed.sha),
            )
          return { committed: true as const, commitSha: committed.sha }
        }
        throw new Error("Default branch kept changing during semantic merge")
      },
    )
  },
)
