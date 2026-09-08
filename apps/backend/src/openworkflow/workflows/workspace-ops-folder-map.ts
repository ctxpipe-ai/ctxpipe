import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { opsFolderMapFiles } from "../../domain/workspaces/hydrate-write-jobs.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
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
import { nativeGit, withGitDirectory } from "../../services/git/pack.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
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

export const workspaceOpsFolderMap = defineWorkflow(
  { name: "workspace-write-ops-folder-map", schema: inputSchema },
  async ({ input: queuedInput, step, run }) => {
    const input = inputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-ops-folder-map",
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
          "ops_folder_map",
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: "ops_folder_map",
            revision: input.revision,
            workflowRunId: run.id,
          }),
        )
        for (let refreshAttempt = 0; refreshAttempt < 3; refreshAttempt++) {
          const acquired = await step.run({ name: "acquire-revision" }, () =>
            acquireWorkspaceWriteRevision(input, revision, env),
          )
          const files = await step.run(
            { name: "transform-ops-folder-map" },
            () =>
              withGitDirectory(
                revision.sha,
                async (directory) => {
                  const paths = (
                    await nativeGit(directory, [
                      "ls-tree",
                      "-r",
                      "--name-only",
                      "-z",
                      revision.sha,
                    ])
                  )
                    .toString()
                    .split("\0")
                  const existingAgentsMd = paths.includes("AGENTS.md")
                    ? (
                        await nativeGit(directory, [
                          "show",
                          `${revision.sha}:AGENTS.md`,
                        ])
                      ).toString()
                    : null
                  return opsFolderMapFiles({
                    displayName: acquired.displayName,
                    existingAgentsMd,
                    paths,
                  })
                },
                acquired.pack,
              ),
          )
          if (!files.length) {
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
          const staged = await step.run({ name: "stage" }, () => {
            if (files.some((file) => file.path !== "AGENTS.md"))
              throw new Error("Folder map maintenance may only edit AGENTS.md")
            return stageGitFiles(acquired.pack, files)
          })
          await step.run({ name: "validate" }, () =>
            validateGitTree(
              staged,
              files.map((file) => file.path),
            ),
          )
          const subject = await step.run({ name: "commit-subject" }, () =>
            generateCommitSubject({
              repoName: repositoryName.split("/")[1] ?? repositoryName,
              trigger: "ops_folder_map",
              fileNames: files.map((file) => file.path),
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
