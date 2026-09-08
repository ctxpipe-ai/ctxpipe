import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  createMergeSandbox,
  destroyMergeSandbox,
  resolveSemanticConflicts,
} from "../../domain/workspaces/semantic-merge.js"
import {
  publishWorkspaceWriteRevision,
  pushWorkspaceCommit,
  refreshWorkspaceWriteRevision,
} from "../../domain/workspaces/write-broker.js"
import {
  acquireWorkspaceWriteRevision,
  completedWorkspaceWrite,
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  persistBoundWriteJob,
  persistWriteJobPreparedCommit,
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

export const semanticMergeContentSchema = z
  .object({
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

export const workspaceSemanticMergeInputSchema = semanticMergeContentSchema
  .safeExtend({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
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
        const completed = await completedWorkspaceWrite(
          input,
          "semantic_merge",
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: "semantic_merge",
            revision: input.revision,
            workflowRunId: run.id,
            previousSha: input.previousSha,
            files: input.files,
            deletePaths: input.deletePaths,
          }),
        )
        for (let refreshAttempt = 0; refreshAttempt < 3; refreshAttempt++) {
          const acquired = await step.run({ name: "acquire-revision" }, () =>
            acquireWorkspaceWriteRevision(
              input,
              revision,
              env,
              input.previousSha,
            ),
          )
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
                const sandbox = await step.run(
                  { name: "create-merge-sandbox" },
                  () => createMergeSandbox(`${run.id}:${refreshAttempt}`),
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
          await step.run({ name: "validate" }, () =>
            validateGitTree(staged, merged.paths),
          )
          const subject = await step.run({ name: "commit-subject" }, () =>
            generateCommitSubject({
              repoName: repositoryName.split("/")[1] ?? repositoryName,
              trigger: "semantic_merge",
              fileNames: merged.paths,
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
          await step.run(
            { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
            () => pushWorkspaceCommit(input, revision, committed, env),
          )
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
        throw new Error("Default branch kept changing during no-op validation")
      },
    )
  },
)
