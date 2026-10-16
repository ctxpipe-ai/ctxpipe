import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import {
  retiredPublishPipelineField,
  workspacePublishPipeline,
} from "../../domain/ingestion/ingestion-v2-config.js"
import type { SourceFileBlob } from "../../domain/workspace-sources/projection-plan.js"
import { readSourcesTree } from "../../domain/workspace-sources/source-tree.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import {
  sameWorkspaceRevision,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import { packWorkspaceFormat } from "../../domain/workspaces/workspace-format-tree.js"
import {
  attemptWorkspaceCommit,
  captureSemanticHandoff,
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
  getMigrationExportSha,
  persistBoundWriteJob,
  persistWriteJobPreparedCommit,
} from "../../models/workspace-write-jobs.js"
import {
  persistWriteJobCommitSha,
  persistWriteJobStatus,
} from "../../models/workspaces.js"
import { readGitFiles } from "../../services/git/pack.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { workspaceHydrate } from "./workspace-hydrate.js"
import { workspaceSemanticMerge } from "./workspace-semantic-merge.js"

const inputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
    /** Retired: a job that was queued with it still parses. */
    publishPipeline: retiredPublishPipelineField,
  })
  .strict()
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

type KnowledgeFile = { path: string; content: string }

/**
 * One maintenance commit that rewrites knowledge Markdown at the bound
 * revision: read each `knowledge/**.md` file, apply `transform`, and publish
 * the changed files as one commit through the write broker. No change is a
 * no-op. The import-key cleanup and the ownership migration (ADR-052) use it.
 */
export function defineKnowledgeRewriteWorkflow(options: {
  name: string
  kind: "import_key_cleanup" | "ownership_migration"
  /** Refuse the write unless the binding has a completed migration export. */
  requireMigrationExport?: boolean
  /**
   * The rewrite is an ingestion v2 publish (the ownership migration). The
   * step that pushes reads the format of the tree that it pushes on, and
   * stops below format 3 (ADR-052 phase 4, G5). A push that loses the race
   * plans again on the new tip, so that each push goes through this check
   * (no semantic merge).
   */
  ingestionV2Publish?: true
  /**
   * `sourceFiles` are the blobs under `sources/` at the same revision;
   * `orgId` is the org of the job.
   */
  transform: (
    files: KnowledgeFile[],
    revision: WorkspaceRevision,
    sourceFiles: SourceFileBlob[],
    orgId: string,
  ) => KnowledgeFile[] | Promise<KnowledgeFile[]>
}) {
  return defineWorkflow(
    { name: options.name, schema: inputSchema },
    async ({ input: queuedInput, step, run }) => {
      const input = inputSchema.parse(queuedInput)
      return withWorkspaceWriteContext(input, options.name, async () => {
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
          options.kind,
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: options.kind,
            revision: input.revision,
            workflowRunId: run.id,
          }),
        )
        if (options.requireMigrationExport)
          await step.run(
            {
              name: "require-migration-cutover",
              retryPolicy: { maximumAttempts: 1 },
            },
            async () => {
              if (
                !(await getMigrationExportSha(
                  input.workspaceId,
                  input.revision,
                ))
              )
                throw new Error(
                  "This write requires a completed migration export for this workspace binding",
                )
            },
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
          const files = await step.run(
            { name: `transform-${options.kind.replaceAll("_", "-")}` },
            async () =>
              options.transform(
                await readGitFiles(
                  acquired.pack,
                  (path) =>
                    path.startsWith("knowledge/") && path.endsWith(".md"),
                ),
                revision,
                (await readSourcesTree(acquired.pack)).sourceFiles,
                input.orgId,
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
            if (
              files.some(
                (file) =>
                  !file.path.startsWith("knowledge/") ||
                  !file.path.endsWith(".md"),
              )
            )
              throw new Error(
                "A knowledge rewrite may only edit knowledge Markdown",
              )
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
              trigger: options.kind,
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
            const attempt = await step.run(
              { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
              async () => {
                // The same step reads the format and pushes. The push lands
                // only on the parent of `committed`, so its tree decides.
                if (
                  options.ingestionV2Publish &&
                  workspacePublishPipeline(
                    await packWorkspaceFormat(committed),
                  ) !== "v2"
                ) {
                  // The job publishes nothing, so it keeps no commit.
                  await discardWriteJobPreparedCommit(
                    input.jobId,
                    committed.sha,
                  )
                  await persistWriteJobStatus(input.jobId, "completed")
                  return { stopped: true as const }
                }
                return attemptWorkspaceCommit(input, revision, committed, env)
              },
            )
            if ("stopped" in attempt)
              return {
                committed: false as const,
                reason: "publish_pipeline_legacy" as const,
              }
            pushed = attempt
            if (pushed.pushed || pushed.reason !== "paused") break
            await step.run({ name: "pause-push" }, () =>
              persistWriteJobStatus(input.jobId, "paused"),
            )
            await step.sleep("await-default-write-access", "1 minute")
            await step.run({ name: "resume-push" }, () =>
              persistWriteJobStatus(input.jobId, "running"),
            )
          }
          if (!pushed.pushed && options.ingestionV2Publish) {
            // The default branch moved: plan again on the new tip.
            await step.run({ name: "discard-unpublished-candidate" }, () =>
              discardWriteJobPreparedCommit(input.jobId, committed.sha),
            )
            revision = await step.run({ name: "refresh-raced-revision" }, () =>
              refreshWorkspaceWriteRevision(input, revision, env),
            )
            continue
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
      })
    },
  )
}
