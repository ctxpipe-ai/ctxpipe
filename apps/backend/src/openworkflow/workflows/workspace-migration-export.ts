import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { isConnectorMirrorPath } from "../../domain/workspaces/layout.js"
import { linkedRepositoryUrlSchema } from "../../domain/workspaces/linked-repository-url.js"
import { planKnowledgeProjection } from "../../domain/workspaces/migration-export.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
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
import { loadKnowledgeProjectionSource } from "../../models/workspace-export.js"
import {
  persistBoundWriteJob,
  persistMigrationExportNoOp,
  persistWriteJobKnowledgePaths,
  persistWriteJobPreparedCommit,
} from "../../models/workspace-write-jobs.js"
import {
  listLinkedRepositories,
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
import { workspaceHydrate } from "./workspace-hydrate.js"
import { workspaceSemanticMerge } from "./workspace-semantic-merge.js"

export const workspaceMigrationExportInputSchema = z
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

export const workspaceMigrationExport = defineWorkflow(
  {
    name: "workspace-write-migration-export",
    schema: workspaceMigrationExportInputSchema,
  },
  async ({ input: queuedInput, step, run }) => {
    const input = workspaceMigrationExportInputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-migration-export",
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
        const result = await (async () => {
          const completed = await completedWorkspaceWrite(
            input,
            "migration_export",
            run.id,
          )
          if (completed) return completed
          await step.run({ name: "claim-command" }, () =>
            persistBoundWriteJob({
              id: input.jobId,
              kind: "migration_export",
              revision: input.revision,
              workflowRunId: run.id,
            }),
          )
          const source = await step.run(
            { name: "load-legacy-source" },
            async () => {
              const source = await loadKnowledgeProjectionSource()
              const linked = await listLinkedRepositories(input.workspaceId)
              return {
                ...source,
                workspaceByRepositoryId: [...source.workspaceByRepositoryId],
                repositoryGitUrlById: [...source.repositoryGitUrlById].flatMap(
                  ([id, url]) => {
                    const safe = linkedRepositoryUrlSchema.safeParse(url)
                    return safe.success
                      ? [[id, safe.data] as [string, string]]
                      : []
                  },
                ),
                linkedUrls: linked.flatMap((row) => {
                  const safe = linkedRepositoryUrlSchema.safeParse(row.gitUrl)
                  return safe.success ? [safe.data] : []
                }),
              }
            },
          )
          for (let refreshAttempt = 0; refreshAttempt < 3; refreshAttempt++) {
            let acquired: NonNullable<
              Awaited<ReturnType<typeof acquireWorkspaceWriteRevision>>
            >
            for (;;) {
              const candidate = await step.run(
                { name: "acquire-revision" },
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
            const transformed = await step.run(
              { name: "transform-migration-export" },
              async () => {
                const existingKnowledge = await readGitFiles(
                  acquired.pack,
                  (path) =>
                    path.endsWith(".md") &&
                    !isConnectorMirrorPath(path) &&
                    (path.startsWith("knowledge/") ||
                      path.startsWith("repositories/")),
                )
                const plan = await planKnowledgeProjection({
                  ...source,
                  workspaceId: input.workspaceId,
                  workspaceRepositoryUrl: revision.remote.url,
                  workspaceByRepositoryId: new Map(
                    source.workspaceByRepositoryId,
                  ),
                  repositoryGitUrlById: new Map(source.repositoryGitUrlById),
                  existingKnowledge,
                  stampImportKey: true,
                })
                return {
                  files: plan.wouldChange ? plan.files : [],
                  knowledgePaths: plan.knowledgePaths,
                }
              },
            )
            await step.run({ name: "record-knowledge-paths" }, () =>
              persistWriteJobKnowledgePaths(
                input.jobId,
                transformed.knowledgePaths,
              ),
            )
            const files = transformed.files
            if (!files.length) {
              const refreshed = await step.run({ name: "confirm-no-op" }, () =>
                refreshWorkspaceWriteRevision(input, revision, env),
              )
              if (!sameWorkspaceRevision(refreshed, revision)) {
                revision = refreshed
                continue
              }
              await step.run({ name: "complete-no-op" }, () =>
                persistMigrationExportNoOp(input.jobId, refreshed.sha),
              )
              return {
                committed: false as const,
                reason: "no_changes" as const,
              }
            }
            const staged = await step.run({ name: "stage" }, () =>
              stageGitFiles(acquired.pack, files),
            )
            await step.run({ name: "validate" }, () =>
              validateGitTree(
                staged,
                files.map((file) => file.path),
              ),
            )
            const subject = await step.run({ name: "commit-subject" }, () =>
              generateCommitSubject({
                repoName: repositoryName.split("/")[1] ?? repositoryName,
                trigger: "migration_export",
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
              if (result.committed) {
                await step.run({ name: "complete-merged-result" }, () =>
                  persistWriteJobCommitSha(input.jobId, result.commitSha),
                )
              } else {
                const published = await step.run(
                  { name: "refresh-merged-no-op" },
                  () =>
                    refreshWorkspaceWriteRevision(input, handoff.revision, env),
                )
                await step.run({ name: "complete-merged-no-op" }, () =>
                  persistMigrationExportNoOp(
                    input.jobId,
                    published.sha,
                    committed.sha,
                  ),
                )
              }
              return result
            }
            await step.run({ name: "publish-result" }, () =>
              publishWorkspaceWriteRevision(input, revision, committed, env),
            )
            await step.run({ name: "complete" }, () =>
              persistWriteJobCommitSha(input.jobId, committed.sha),
            )
            return { committed: true as const, commitSha: committed.sha }
          }
          throw new Error(
            "Default branch kept changing during no-op validation",
          )
        })()
        const published = await step.run(
          { name: "refresh-export-publication" },
          () => refreshWorkspaceWriteRevision(input, input.revision, env),
        )
        await step.run({ name: "enqueue-export-hydrate" }, async () => {
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
        return result
      },
    )
  },
)
