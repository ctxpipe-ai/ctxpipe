import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { SOURCES_FOLDER_PREFIX } from "../../domain/workspace-sources/source-tree.js"
import { SOURCES_FILE_PATH } from "../../domain/workspace-sources/sources-file.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { isLinkedRepositoryDeclaration } from "../../domain/workspaces/layout.js"
import { changeLinkedRepository } from "../../domain/workspaces/link-declarations.js"
import { linkedRepositoryUrlSchema } from "../../domain/workspaces/linked-repository-url.js"
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
import { readGitFiles } from "../../services/git/pack.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

export const workspaceLinkUnlinkInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
    linkAction: z.enum(["link", "unlink"]),
    linkGitUrl: linkedRepositoryUrlSchema,
  })
  .strict()
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

export const workspaceLinkUnlink = defineWorkflow(
  {
    name: "workspace-write-link-unlink",
    schema: workspaceLinkUnlinkInputSchema,
  },
  async ({ input: queuedInput, step, run }) => {
    const input = workspaceLinkUnlinkInputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-link-unlink",
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
          "link_unlink",
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: "link_unlink",
            revision: input.revision,
            linkAction: input.linkAction,
            linkGitUrl: input.linkGitUrl,
            workflowRunId: run.id,
          }),
        )
        // A lost push race reads the new tip and makes the same edit again.
        // A link edit never goes through the semantic merge: a model merge
        // can break a file under `sources/`, and with it a link.
        for (let attempt = 0; attempt < 8; attempt++) {
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
            { name: "transform-link-unlink" },
            async () => {
              const files = await readGitFiles(
                acquired.pack,
                (path) =>
                  path === SOURCES_FILE_PATH ||
                  path.startsWith(SOURCES_FOLDER_PREFIX) ||
                  isLinkedRepositoryDeclaration(path),
              )
              return changeLinkedRepository({
                files,
                action: input.linkAction,
                gitUrl: input.linkGitUrl,
                connectionId,
              })
            },
          )
          if (changes.refused) {
            const refused = changes.refused
            getLogger().set({ linkRefused: refused })
            await step.run({ name: "fail-refused" }, () =>
              persistWriteJobStatus(input.jobId, "failed", refused),
            )
            return {
              committed: false as const,
              reason: "refused" as const,
            }
          }
          const files = changes.files
          const deletePaths = changes.deletePaths
          if (!files.length && !deletePaths.length) {
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
          const changedPaths = [
            ...files.map((file) => file.path),
            ...deletePaths,
          ]
          const staged = await step.run({ name: "stage" }, () =>
            stageGitFiles(acquired.pack, files, deletePaths),
          )
          await step.run({ name: "validate" }, () =>
            validateGitTree(staged, changedPaths),
          )
          const subject = await step.run({ name: "commit-subject" }, () =>
            generateCommitSubject({
              repoName: repositoryName.split("/")[1] ?? repositoryName,
              trigger: "link_unlink",
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
            // The push lost the race, so the candidate is not on the remote.
            // Release it: the next attempt records its own candidate.
            await step.run({ name: "discard-candidate" }, () =>
              discardWriteJobPreparedCommit(input.jobId, committed.sha),
            )
            revision = await step.run(
              { name: "read-new-tip", retryPolicy: { maximumAttempts: 3 } },
              () => refreshWorkspaceWriteRevision(input, revision, env),
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
        throw new Error("Default branch kept changing during the link edit")
      },
    )
  },
)
