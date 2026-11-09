import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { connectorMirrorContentSchema } from "../../domain/workspaces/connector-mirror-input.js"
import { workspaceGitRead } from "../../domain/workspaces/resolve-revision.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  attemptWorkspaceCommit,
  captureSemanticHandoff,
  deleteWriteJobRefs,
  publishWorkspaceWriteRevision,
  refreshWorkspaceWriteRevision,
} from "../../domain/workspaces/write-broker.js"
import {
  acquireWorkspaceWriteRevision,
  completedWorkspaceWrite,
  prepareWorkspaceWriteCommit,
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { persistBoundWriteJob } from "../../models/workspace-write-jobs.js"
import {
  persistWriteJobCommitSha,
  persistWriteJobStatus,
} from "../../models/workspaces.js"
import { gitFileBytes } from "../../services/git/file-change.js"
import {
  nativeGit,
  packRootTree,
  withGitDirectory,
} from "../../services/git/pack.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runJobRefStep } from "../write-steps.js"
import { workspaceHydrate } from "./workspace-hydrate.js"
import { workspaceSemanticMerge } from "./workspace-semantic-merge.js"

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
        // Read access to the bound repository, from the workflow input (CTX-955).
        const read = workspaceGitRead({
          orgId: input.orgId,
          env,
          remote: input.revision.remote,
        })
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
          // Paths only: the file contents are in the workflow input
          // (CTX-1235).
          const changes = await step.run(
            { name: "transform-connector-mirror-v2" },
            () =>
              withGitDirectory(
                revision.sha,
                async (directory) => {
                  const tree = await packRootTree(directory, acquired.pack)
                  const paths = tree
                    ? (
                        await nativeGit(directory, [
                          "ls-tree",
                          "-r",
                          "--name-only",
                          "-z",
                          tree,
                        ])
                      )
                        .toString()
                        .split("\0")
                    : []
                  const filePaths: string[] = []
                  for (const file of input.files) {
                    const existing = paths.includes(file.path)
                      ? await nativeGit(directory, [
                          "show",
                          `${tree}:${file.path}`,
                        ])
                      : null
                    if (!existing?.equals(gitFileBytes(file)))
                      filePaths.push(file.path)
                  }
                  return {
                    filePaths,
                    deletePaths: input.deletePaths.filter((path) =>
                      paths.includes(path),
                    ),
                  }
                },
                acquired.pack,
                read,
              ),
          )
          const changed = new Set(changes.filePaths)
          const files = input.files.filter((file) => changed.has(file.path))
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
          const committed = await runJobRefStep(
            step,
            input.jobId,
            { name: "prepare-commit" },
            () =>
              prepareWorkspaceWriteCommit(
                input,
                revision,
                acquired.pack,
                { files, deletePaths: changes.deletePaths },
                { subject, createdAt: run.createdAt },
                env,
              ),
          )
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
            const handoff = await step.run(
              { name: "capture-semantic-handoff" },
              () =>
                captureSemanticHandoff(input, revision, committed, env, "host"),
            )
            const result = await step.runWorkflow(
              workspaceSemanticMerge.spec,
              handoff,
              { name: "semantic-merge-child" },
            )
            await step.run({ name: "complete-merged-result" }, async () => {
              await persistWriteJobCommitSha(
                input.jobId,
                result.committed ? result.commitSha : null,
              )
              await deleteWriteJobRefs(
                { ...input, remote: input.revision.remote },
                env,
              )
            })
            return result
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
          await step.run({ name: "complete" }, async () => {
            await persistWriteJobCommitSha(input.jobId, committed.sha)
            await deleteWriteJobRefs(
              { ...input, remote: input.revision.remote },
              env,
            )
          })
          return { committed: true as const, commitSha: committed.sha }
        }
        throw new Error("Default branch kept changing during no-op validation")
      },
    )
  },
)
