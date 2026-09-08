import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import {
  BOOTSTRAP_SKILL_PATH,
  bootstrapWorkspaceFiles,
} from "../../domain/workspaces/bootstrap.js"
import { unbornBootstrapBindingSchema } from "../../domain/workspaces/bootstrap-input.js"
import { getUnbornBootstrapWorkspace } from "../../domain/workspaces/bootstrap-unborn.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import {
  sameWorkspaceRevision,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
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
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { isBootstrapAllowedPath } from "../../domain/workspaces/write-jobs.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  adoptInitializedBootstrapRevision,
  persistBoundWriteJob,
  persistUnbornBootstrapJob,
  persistWriteJobPreparedCommit,
} from "../../models/workspace-write-jobs.js"
import {
  persistWriteJobCommitSha,
  persistWriteJobStatus,
} from "../../models/workspaces.js"
import { nativeGit, withGitDirectory } from "../../services/git/pack.js"
import {
  commitUnbornGitTree,
  stageUnbornGitFiles,
  validateUnbornGitTree,
} from "../../services/git/unborn-tree.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
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
              return { status: job.status, commitSha: job.commitSha }
            },
          )
          if (claimed.status === "completed") {
            if (!claimed.commitSha)
              throw new Error("Completed root bootstrap has no commit")
            return {
              kind: "completed" as const,
              result: {
                committed: true as const,
                commitSha: claimed.commitSha,
              },
            }
          }
          const files = await step.run(
            { name: "transform-unborn" },
            async () => {
              const workspace = await getUnbornBootstrapWorkspace(
                queued.bootstrapBinding,
              )
              return bootstrapWorkspaceFiles({
                displayName: workspace.displayName,
                existing: new Map(),
              })
            },
          )
          const staged = await step.run({ name: "stage-unborn" }, () =>
            stageUnbornGitFiles(files),
          )
          await step.run({ name: "validate-unborn" }, () =>
            validateUnbornGitTree(
              staged,
              files
                .filter((file) => isBootstrapAllowedPath(file.path))
                .map((file) => file.path),
            ),
          )
          const committed = await step.run(
            { name: "commit-unborn" },
            async () => {
              const pack = await commitUnbornGitTree(staged, {
                subject: "ctxpipe - Bootstrap workspace",
                createdAt: run.createdAt,
              })
              await persistWriteJobPreparedCommit(queued.jobId, pack.sha)
              return pack
            },
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
            await runWorkflowWithWorkerWake(
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
            persistWriteJobCommitSha(queued.jobId, committed.sha),
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
          const files = await step.run({ name: "transform-bootstrap" }, () =>
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
                const existing = new Map<string, string>()
                for (const path of ["AGENTS.md", BOOTSTRAP_SKILL_PATH]) {
                  if (paths.includes(path))
                    existing.set(
                      path,
                      (
                        await nativeGit(directory, [
                          "show",
                          `${revision.sha}:${path}`,
                        ])
                      ).toString(),
                    )
                }
                return bootstrapWorkspaceFiles({
                  displayName: acquired.displayName,
                  existing,
                }).filter((file) => existing.get(file.path) !== file.content)
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
            if (files.some((file) => !isBootstrapAllowedPath(file.path)))
              throw new Error("Bootstrap path is outside its allowed files")
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
              trigger: "bootstrap",
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
              () => captureSemanticHandoff(input, revision, committed, env),
            )
            const result = await step.runWorkflow(
              workspaceSemanticMerge.spec,
              handoff,
              { name: "semantic-merge-child" },
            )
            await step.run({ name: "complete-merged-result" }, () =>
              persistWriteJobCommitSha(
                input.jobId,
                result.committed ? result.commitSha : null,
              ),
            )
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
            persistWriteJobCommitSha(input.jobId, committed.sha),
          )
          return { committed: true as const, commitSha: committed.sha }
        }
        throw new Error("Default branch kept changing during no-op validation")
      },
    )
  },
)
