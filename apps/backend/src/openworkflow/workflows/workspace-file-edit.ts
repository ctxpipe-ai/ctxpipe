import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { hostOnlyRefusal } from "../../domain/workspaces/host-only.js"
import { workspaceGitRead } from "../../domain/workspaces/resolve-revision.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
  withWorkspaceFormatFields,
} from "../../domain/workspaces/workspace-format.js"
import {
  attemptWorkspaceCommit,
  captureSemanticHandoff,
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
import { persistBoundWriteJob } from "../../models/workspace-write-jobs.js"
import { persistWriteJobStatus } from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { repositoryFilePathSchema } from "../../services/git/file-change.js"
import { readGitFiles } from "../../services/git/pack.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runJobRefStep } from "../write-steps.js"
import { workspaceHydrate } from "./workspace-hydrate.js"
import { workspaceSemanticMerge } from "./workspace-semantic-merge.js"

export const workspaceFileEditInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
    files: z.array(
      z
        .object({ path: repositoryFilePathSchema, content: z.string() })
        .strict(),
    ),
    deletePaths: z.array(repositoryFilePathSchema),
  })
  .strict()
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

export const workspaceFileEdit = defineWorkflow(
  {
    name: "workspace-write-ui-file-edit",
    schema: workspaceFileEditInputSchema,
    retryPolicy: { maximumAttempts: 1 },
  },
  async ({ input: queuedInput, step, run }) => {
    const input = workspaceFileEditInputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-ui-file-edit",
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
          "ui_file_edit",
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: "ui_file_edit",
            revision: input.revision,
            files: input.files,
            deletePaths: input.deletePaths,
            workflowRunId: run.id,
          }),
        )
        // Planning refuses host-only paths too, but a job queued or paused
        // before that check can still resume here (CTX-722). The one host
        // write is the upgrade setting in the format file (Always update):
        // the transform below keeps the format of the tree.
        const refusal = hostOnlyRefusal([
          ...input.files
            .map((file) => file.path)
            .filter((path) => path !== WORKSPACE_FORMAT_PATH),
          ...input.deletePaths,
        ])
        if (refusal) {
          // A refusal is permanent: fail the job row now so it cannot hold up
          // the write queue, and never retry it.
          await step.run(
            { name: "refuse-command", retryPolicy: { maximumAttempts: 1 } },
            () => persistWriteJobStatus(input.jobId, "failed"),
          )
          throw new Error(refusal)
        }
        // Always update writes only the format file. After that write is
        // done and its job is marked, a scan starts the waiting upgrades of
        // the org with no click, also after the user left the page that asked
        // for it. The setting is already saved by then, so a failed enqueue
        // is logged and does not change the job. The scan workflow imports
        // the write path, so the import is late.
        const scanAfterSetting = async () => {
          if (!input.files.some((file) => file.path === WORKSPACE_FORMAT_PATH))
            return
          await step.run({ name: "enqueue-upgrade-scan" }, async () => {
            try {
              const { enqueueWorkspaceUpgradeScan } =
                await import("./workspace-upgrade-scan.js")
              await enqueueWorkspaceUpgradeScan({
                orgId: input.orgId,
                trigger: `setting:${input.jobId}`,
              })
            } catch (error) {
              log.error({
                action: "workspace_file_edit.upgrade_scan_enqueue_failed",
                jobId: input.jobId,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          })
        }
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
                  change: async () => {
                  const named = new Set([
                    ...input.files.map((file) => file.path),
                    ...input.deletePaths,
                  ])
                  // Root-relative paths below the Workspace root folder.
                  const existing = new Map(
                    (
                      await readGitFiles(
                        acquired.pack,
                        (path) => named.has(path),
                        undefined,
                        read,
                      )
                    ).map((file) => [file.path, file.content]),
                  )
                  // The format file changes only in its upgrade setting: a merged
                  // upgrade pull request can have changed the format after the
                  // job was queued.
                  const files = input.files.map((file) => {
                    if (file.path !== WORKSPACE_FORMAT_PATH) return file
                    const requested = readWorkspaceFormat(file.content)
                    const content =
                      requested.kind === "format"
                        ? withWorkspaceFormatFields(
                            existing.get(file.path) ?? null,
                            { upgrades: requested.upgrades },
                          )
                        : null
                    if (content === null)
                      throw new Error(
                        `${WORKSPACE_FORMAT_PATH} is not valid. ctxpipe cannot change its upgrade setting.`,
                      )
                    return { path: file.path, content }
                  })
                  return {
                    files: files.filter(
                      (file) => existing.get(file.path) !== file.content,
                    ),
                    deletePaths: input.deletePaths.filter((path) =>
                      existing.has(path),
                    ),
                  }
                  },
                  subject: { trigger: "ui_file_edit" },
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
              continue
            }
            await step.run({ name: "complete-no-op" }, () =>
              persistWriteJobStatus(input.jobId, "completed"),
            )
            await scanAfterSetting()
            return {
              committed: false as const,
              reason: "no_changes" as const,
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
            const handoff = await step.run(
              { name: "capture-semantic-handoff-v2" },
              () =>
                captureSemanticHandoff(input, revision, committed, env, "host"),
            )
            const result = await step.runWorkflow(
              workspaceSemanticMerge.spec,
              handoff,
              { name: "semantic-merge-child" },
            )
            await step.run({ name: "complete-merged-result" }, () =>
              completeWorkspaceWrite(
                { ...input, remote: input.revision.remote },
                result.committed ? result.commitSha : null,
                env,
              ),
            )
            await scanAfterSetting()
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
          await step.run({ name: "complete" }, () =>
            completeWorkspaceWrite(
              { ...input, remote: input.revision.remote },
              committed.sha,
              env,
            ),
          )
          await scanAfterSetting()
          return { committed: true as const, commitSha: committed.sha }
        }
        throw new Error("Default branch kept changing during no-op validation")
      },
    )
  },
)
