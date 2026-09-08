import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { isConnectorMirrorPath } from "../../domain/workspaces/layout.js"
import { linkedRepositoryUrlSchema } from "../../domain/workspaces/linked-repository-url.js"
import { planMigrationExport } from "../../domain/workspaces/migration-export.js"
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
import { loadMigrationExportSource } from "../../models/workspace-export.js"
import {
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
import { workspaceHydrate } from "./workspace-hydrate.js"

export const workspaceExtractIngestInputSchema = z
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

export const workspaceExtractIngest = defineWorkflow(
  {
    name: "workspace-write-extract-ingest",
    schema: workspaceExtractIngestInputSchema,
  },
  async ({ input: queuedInput, step, run }) => {
    const input = workspaceExtractIngestInputSchema.parse(queuedInput)
    return withWorkspaceWriteContext(
      input,
      "workspace-write-extract-ingest",
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
          "extract_ingest",
          run.id,
        )
        if (completed) return completed
        await step.run({ name: "claim-command" }, () =>
          persistBoundWriteJob({
            id: input.jobId,
            kind: "extract_ingest",
            revision: input.revision,
            workflowRunId: run.id,
          }),
        )
        const source = await step.run(
          { name: "load-legacy-source" },
          async () => {
            const source = await loadMigrationExportSource()
            const exportSha = await getMigrationExportSha(input.workspaceId)
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
              stampImportKey: !exportSha,
              linkedUrls: [],
            }
          },
        )
        for (let refreshAttempt = 0; refreshAttempt < 3; refreshAttempt++) {
          const acquired = await step.run({ name: "acquire-revision" }, () =>
            acquireWorkspaceWriteRevision(input, revision, env),
          )
          const files = await step.run(
            { name: "transform-extract-ingest" },
            async () => {
              const existingKnowledge = await readGitFiles(
                acquired.pack,
                (path) =>
                  path.endsWith(".md") &&
                  !isConnectorMirrorPath(path) &&
                  (path.startsWith("knowledge/") ||
                    path.startsWith("repositories/")),
              )
              const plan = await planMigrationExport({
                ...source,
                workspaceId: input.workspaceId,
                workspaceRepositoryUrl: revision.remote.url,
                workspaceByRepositoryId: new Map(
                  source.workspaceByRepositoryId,
                ),
                repositoryGitUrlById: new Map(source.repositoryGitUrlById),
                existingKnowledge,
                stampImportKey: source.stampImportKey,
              })
              const existing = new Map(
                existingKnowledge.map((file) => [file.path, file.content]),
              )
              return plan.files.filter(
                (file) =>
                  file.path.startsWith("knowledge/") &&
                  existing.get(file.path) !== file.content,
              )
            },
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
              trigger: "extract_ingest",
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
