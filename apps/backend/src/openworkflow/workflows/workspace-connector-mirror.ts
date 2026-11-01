import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { connectorMirrorContentSchema } from "../../domain/workspaces/connector-mirror-input.js"
import { mirrorWriteChanges } from "../../domain/workspaces/mirror-write-changes.js"
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
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
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
  nativeGit,
  packRootTree,
  withGitDirectory,
} from "../../services/git/pack.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

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
        // A mirror write never goes to the semantic merge (CTX-1104). Each
        // attempt compares the write with the tip that it acquires. When a
        // file on the tip is a strictly newer snapshot, the write is stale and
        // changes nothing. When the tip moves, the write reads it again and
        // tries again. A lost push and a moved tip at the no-op check use the same
        // count: both are a turn of the loop on a tip that moves.
        const attempts = 5
        for (let attempt = 0; attempt < attempts; attempt++) {
          let acquired: NonNullable<
            Awaited<ReturnType<typeof acquireWorkspaceWriteRevision>>
          >
          for (;;) {
            const candidate = await step.run({ name: "acquire-revision" }, () =>
              acquireWorkspaceWriteRevision(input, revision, env),
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
            { name: "transform-connector-mirror" },
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
                  const { staleDropped, ...changes } = await mirrorWriteChanges(
                    input,
                    async (path) =>
                      paths.includes(path)
                        ? nativeGit(directory, ["show", `${tree}:${path}`])
                        : null,
                  )
                  if (staleDropped > 0)
                    getLogger().info("connector-mirror.stale-dropped", {
                      step: "connector-mirror.stale-dropped",
                      staleDropped,
                      kept: changes.files.length,
                    })
                  return changes
                },
                acquired.pack,
                read,
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
            stageGitFiles(acquired.pack, files, changes.deletePaths, read),
          )
          await step.run({ name: "validate" }, () =>
            validateGitTree(
              staged,
              [...files.map((file) => file.path), ...changes.deletePaths],
              {},
              read,
            ),
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
            const pack = await commitGitTree(
              staged,
              {
                subject,
                createdAt: run.createdAt,
              },
              read,
            )
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
          await step.run({ name: "complete" }, () =>
            persistWriteJobCommitSha(input.jobId, committed.sha),
          )
          return { committed: true as const, commitSha: committed.sha }
        }
        // The job must not stay running with no commit. The next sync of the
        // item writes it again.
        const failure = `The default branch moved during each of ${attempts} attempts of the connector mirror write`
        await step.run({ name: "fail-raced-command" }, () =>
          persistWriteJobStatus(input.jobId, "failed", failure),
        )
        throw new Error(failure)
      },
    )
  },
)
