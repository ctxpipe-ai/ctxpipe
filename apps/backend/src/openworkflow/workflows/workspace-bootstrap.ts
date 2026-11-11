import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { unbornBootstrapBindingSchema } from "../../domain/workspaces/bootstrap-input.js"
import { revisionHasCtxpipeContent } from "../../domain/workspaces/bootstrap-unborn.js"
import {
  BOOTSTRAP_SKILL_PATH,
  bootstrapWorkspaceFiles,
} from "../../domain/workspaces/bootstrap.js"
import { workspaceGitRead } from "../../domain/workspaces/resolve-revision.js"
import {
  sameWorkspaceRevision,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  CTXPIPE_CONTENT_FOLDERS,
  hasCtxpipeContent,
  WORKSPACE_FORMAT_PATH,
  workspaceFormatFile,
} from "../../domain/workspaces/workspace-format.js"
import {
  attemptWorkspaceCommit,
  captureSemanticHandoff,
  publishWorkspaceWriteRevision,
  pushUnbornWorkspaceCommit,
  refreshWorkspaceWriteRevision,
} from "../../domain/workspaces/write-broker.js"
import {
  acquireWorkspaceWriteRevision,
  completedWorkspaceWrite,
  completeWorkspaceWrite,
  prepareUnbornWorkspaceCommit,
  prepareWorkspaceWriteCommit,
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { isBootstrapAllowedPath } from "../../domain/workspaces/write-jobs.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  adoptInitializedBootstrapRevision,
  persistBoundWriteJob,
  persistUnbornBootstrapJob,
} from "../../models/workspace-write-jobs.js"
import { persistWriteJobStatus } from "../../models/workspaces.js"
import {
  listTreeBlobs,
  packRootTree,
  readGitFiles,
  withGitDirectory,
} from "../../services/git/pack.js"
import { enqueueWorkflow } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runJobRefStep } from "../write-steps.js"
import { workspaceHydrate } from "./workspace-hydrate.js"
import { workspaceSemanticMerge } from "./workspace-semantic-merge.js"

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

const bootstrapInputSchema = z.union([
  inputSchema,
  z
    .object({
      orgId: z.string().min(1),
      workspaceId: z.string().min(1),
      jobId: z.string().min(1),
      bootstrapBinding: unbornBootstrapBindingSchema,
    })
    .strict()
    .refine(
      (input) => input.workspaceId === input.bootstrapBinding.workspaceId,
      "Bootstrap workspace binding must match",
    ),
])

export const workspaceBootstrap = defineWorkflow(
  { name: "workspace-write-bootstrap", schema: bootstrapInputSchema },
  async ({ input: queuedInput, step, run }) => {
    const queued = bootstrapInputSchema.parse(queuedInput)
    let initializedRevision: WorkspaceRevision | undefined
    if ("bootstrapBinding" in queued) {
      const outcome = await withWorkspaceWriteContext(
        queued,
        "workspace-write-bootstrap",
        async () => {
          const env = parseEnv(process.env)
          const claimed = await step.run(
            { name: "claim-unborn-command" },
            async () => {
              const job = await persistUnbornBootstrapJob({
                id: queued.jobId,
                binding: queued.bootstrapBinding,
                workflowRunId: run.id,
              })
              return {
                status: job.status,
                commitSha: job.commitSha,
                initialized: Boolean(job.payload?.revision),
              }
            },
          )
          if (claimed.status === "completed") {
            if (!claimed.commitSha && !claimed.initialized)
              throw new Error("Completed root bootstrap has no commit")
            return {
              kind: "completed" as const,
              result: claimed.commitSha
                ? {
                    committed: true as const,
                    commitSha: claimed.commitSha,
                  }
                : { committed: false as const, reason: "no_changes" as const },
            }
          }
          // One step makes the first commit and pushes it to its job ref: no
          // step output holds a file (CTX-1239).
          const committed = await runJobRefStep(
            step,
            queued.jobId,
            { name: "prepare-commit-unborn" },
            () =>
              prepareUnbornWorkspaceCommit(
                queued,
                {
                  // A new repository gets the format file in its bootstrap
                  // commit (ADR-053).
                  files: (displayName) => [
                    ...bootstrapWorkspaceFiles({
                      displayName,
                      existing: new Map(),
                    }),
                    workspaceFormatFile(),
                  ],
                  allowedPath: (path) =>
                    isBootstrapAllowedPath(path) ||
                    path === WORKSPACE_FORMAT_PATH,
                  createdAt: run.createdAt,
                },
                env,
              ),
          )
          for (;;) {
            const pushed = await step.run(
              {
                name: "broker-push-unborn",
                retryPolicy: { maximumAttempts: 3 },
              },
              () => pushUnbornWorkspaceCommit(queued, committed, env),
            )
            if (pushed.kind === "pushed") break
            if (pushed.kind === "initialized") {
              await step.run({ name: "adopt-initialized-revision" }, () =>
                adoptInitializedBootstrapRevision({
                  jobId: queued.jobId,
                  workflowRunId: run.id,
                  binding: queued.bootstrapBinding,
                  revision: pushed.revision,
                  candidateSha: committed.sha,
                }),
              )
              await step.run({ name: "hydrate-initialized-revision" }, () =>
                enqueueWorkflow(
                  workspaceHydrate.spec,
                  {
                    orgId: queued.orgId,
                    workspaceId: queued.workspaceId,
                    revision: { ...pushed.revision, access: "read" },
                  },
                  { idempotencyKey: `${queued.jobId}:initialized-hydrate` },
                ),
              )
              return { kind: "initialized" as const, revision: pushed.revision }
            }
            await step.run({ name: "pause-unborn" }, () =>
              persistWriteJobStatus(queued.jobId, "paused"),
            )
            await step.sleep("await-unborn-write-access", "1 minute")
            await step.run({ name: "resume-unborn" }, () =>
              persistWriteJobStatus(queued.jobId, "running"),
            )
          }
          const published = await step.run({ name: "publish-unborn" }, () =>
            publishWorkspaceWriteRevision(
              queued,
              {
                ...queued.bootstrapBinding,
                sha: committed.sha,
                access: "write-default",
              },
              committed,
              env,
            ),
          )
          await step.run({ name: "hydrate-unborn" }, async () => {
            await enqueueWorkflow(
              workspaceHydrate.spec,
              {
                orgId: queued.orgId,
                workspaceId: queued.workspaceId,
                revision: published,
              },
              { idempotencyKey: `${queued.jobId}:hydrate` },
            )
          })
          await step.run({ name: "complete-unborn" }, () =>
            completeWorkspaceWrite(
              { ...queued, remote: queued.bootstrapBinding.remote },
              committed.sha,
              env,
            ),
          )
          return {
            kind: "completed" as const,
            result: { committed: true as const, commitSha: committed.sha },
          }
        },
      )
      if (outcome.kind === "completed") return outcome.result
      initializedRevision = outcome.revision
    }
    const input = inputSchema.parse(
      "revision" in queued
        ? queued
        : {
            orgId: queued.orgId,
            workspaceId: queued.workspaceId,
            jobId: queued.jobId,
            revision: initializedRevision,
          },
    )
    return withWorkspaceWriteContext(
      input,
      "workspace-write-bootstrap",
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
          "bootstrap",
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: "bootstrap",
            revision: input.revision,
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
                    const existing = new Map(
                      (
                        await readGitFiles(
                          acquired.pack,
                          (path) =>
                            ["AGENTS.md", BOOTSTRAP_SKILL_PATH].includes(path),
                          undefined,
                          read,
                        )
                      ).map((file) => [file.path, file.content]),
                    )
                    // A repository with no ctxpipe content is new, so the bootstrap
                    // commit writes the format file. A repository with ctxpipe
                    // content keeps its format (ADR-053).
                    const isNew = !hasCtxpipeContent(
                      (
                        await withGitDirectory(
                          acquired.pack.sha,
                          async (directory) => {
                            const tree = await packRootTree(
                              directory,
                              acquired.pack,
                            )
                            return tree
                              ? listTreeBlobs(
                                  directory,
                                  tree,
                                  CTXPIPE_CONTENT_FOLDERS,
                                )
                              : []
                          },
                          acquired.pack,
                          read,
                        )
                      ).map((blob) => blob.path),
                    )
                    const files = [
                      ...bootstrapWorkspaceFiles({
                        displayName: acquired.displayName,
                        existing,
                      }).filter(
                        (file) => existing.get(file.path) !== file.content,
                      ),
                      ...(isNew ? [workspaceFormatFile()] : []),
                    ]
                    if (
                      files.some(
                        (file) =>
                          !isBootstrapAllowedPath(file.path) &&
                          file.path !== WORKSPACE_FORMAT_PATH,
                      )
                    )
                      throw new Error(
                        "Bootstrap path is outside its allowed files",
                      )
                    return { files, deletePaths: [] }
                  },
                  subject: { trigger: "bootstrap" },
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
                captureSemanticHandoff(
                  input,
                  revision,
                  committed,
                  env,
                  "host",
                  // The tip moved after the bind. The format file of a new
                  // repository must not go onto a tree that now has ctxpipe
                  // content: that repository keeps its format (ADR-053).
                  async (next) =>
                    (await revisionHasCtxpipeContent(input.orgId, next))
                      ? [WORKSPACE_FORMAT_PATH]
                      : [],
                ),
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
            return result
          }
          const published = await step.run({ name: "publish-result" }, () =>
            publishWorkspaceWriteRevision(input, revision, committed, env),
          )
          await step.run({ name: "enqueue-hydrate" }, async () => {
            await enqueueWorkflow(
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
          return { committed: true as const, commitSha: committed.sha }
        }
        throw new Error("Default branch kept changing during no-op validation")
      },
    )
  },
)
