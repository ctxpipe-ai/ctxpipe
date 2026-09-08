import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { connectorMirrorSourceSchema } from "../../domain/workspaces/connector-mirror.js"
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
import {
  gitFileBytes,
  gitFileChangeSchema,
  repositoryFilePathSchema,
} from "../../services/git/file-change.js"
import { nativeGit, withGitDirectory } from "../../services/git/pack.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

export const connectorMirrorContentSchema = z
  .object({
    mirror: connectorMirrorSourceSchema,
    files: z.array(gitFileChangeSchema),
    deletePaths: z.array(repositoryFilePathSchema),
  })
  .strict()
  .refine(
    (input) =>
      [...input.files.map((file) => file.path), ...input.deletePaths].every(
        (path) =>
          path.startsWith(`${input.mirror.provider}/`) &&
          path !== `${input.mirror.provider}/config.yaml`,
      ),
    "A mirror may only change content under its managed provider root",
  )
  .refine(
    (input) =>
      new Set([...input.files.map((file) => file.path), ...input.deletePaths])
        .size ===
      input.files.length + input.deletePaths.length,
    "Each mirror path must have exactly one operation",
  )

export const workspaceConnectorMirrorInputSchema = connectorMirrorContentSchema
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

export const workspaceConnectorMirror = defineWorkflow(
  {
    name: "workspace-write-connector-mirror",
    schema: workspaceConnectorMirrorInputSchema,
  },
  async ({ input: queuedInput, step, run }) => {
    const input = workspaceConnectorMirrorInputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-connector-mirror",
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
          "connector_mirror",
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: "connector_mirror",
            revision: input.revision,
            files: input.files,
            mirror: input.mirror,
            deletePaths: input.deletePaths,
            workflowRunId: run.id,
          }),
        )
        for (let refreshAttempt = 0; refreshAttempt < 3; refreshAttempt++) {
          const acquired = await step.run({ name: "acquire-revision" }, () =>
            acquireWorkspaceWriteRevision(input, revision, env),
          )
          const changes = await step.run(
            { name: "transform-connector-mirror" },
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
                  const files: typeof input.files = []
                  for (const file of input.files) {
                    const existing = paths.includes(file.path)
                      ? await nativeGit(directory, [
                          "show",
                          `${revision.sha}:${file.path}`,
                        ])
                      : null
                    if (!existing?.equals(gitFileBytes(file))) files.push(file)
                  }
                  return {
                    files,
                    deletePaths: input.deletePaths.filter((path) =>
                      paths.includes(path),
                    ),
                  }
                },
                acquired.pack,
              ),
          )
          const files = changes.files
          if (!files.length && !changes.deletePaths.length) {
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
          const staged = await step.run({ name: "stage" }, () =>
            stageGitFiles(acquired.pack, files, changes.deletePaths),
          )
          await step.run({ name: "validate" }, () =>
            validateGitTree(staged, [
              ...files.map((file) => file.path),
              ...changes.deletePaths,
            ]),
          )
          const subject = await step.run({ name: "commit-subject" }, () =>
            generateCommitSubject({
              repoName: repositoryName.split("/")[1] ?? repositoryName,
              trigger: "connector_mirror",
              fileNames: [
                ...files.map((file) => file.path),
                ...changes.deletePaths,
              ],
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
