import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { isConnectorMirrorPath } from "../../domain/workspaces/layout.js"
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
  persistBoundWriteJob,
  persistMigrationExportNoOp,
  persistWriteJobPreparedCommit,
} from "../../models/workspace-write-jobs.js"
import {
  listLinkedRepositories,
  persistWriteJobCommitSha,
} from "../../models/workspaces.js"
import { readGitFiles } from "../../services/git/pack.js"
import {
  commitGitTree,
  stageGitFiles,
  validateGitTree,
} from "../../services/git/write-tree.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

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
            const source = await loadMigrationExportSource()
            const linked = await listLinkedRepositories(input.workspaceId)
            return {
              ...source,
              workspaceByRepositoryId: [...source.workspaceByRepositoryId],
              repositoryGitUrlById: [...source.repositoryGitUrlById],
              linkedUrls: linked.map((row) => row.gitUrl),
            }
          },
        )
        for (let refreshAttempt = 0; refreshAttempt < 3; refreshAttempt++) {
          const acquired = await step.run({ name: "acquire-revision" }, () =>
            acquireWorkspaceWriteRevision(input, revision, env),
          )
          const files = await step.run(
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
              const plan = await planMigrationExport({
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
              return plan.wouldChange ? plan.files : []
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
            await step.run({ name: "enqueue-no-op-hydrate" }, async () => {
              await runWorkflowWithWorkerWake(
                workspaceHydrate.spec,
                {
                  orgId: input.orgId,
                  workspaceId: input.workspaceId,
                  revision: refreshed,
                },
                { idempotencyKey: `${input.jobId}:hydrate` },
              )
            })
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
