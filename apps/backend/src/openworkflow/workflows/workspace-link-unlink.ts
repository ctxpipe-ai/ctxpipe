import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import {
  type IngestionPublishPipeline,
  ingestionPublishPipeline,
  ingestionPublishPipelineSchema,
} from "../../domain/ingestion/ingestion-v2-config.js"
import { planUnlinkRetraction } from "../../domain/ingestion/unlink-retraction.js"
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
    /**
     * The publish pipeline when the job was queued. While it is `v2`, an
     * unlink also retracts what the repository owns (ADR-052 section 3).
     * The step that pushes reads the committed value again: when it does not
     * agree with the plan, the unlink plans again with the committed value.
     */
    publishPipeline: ingestionPublishPipelineSchema.default("legacy"),
  })
  .strict()
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

/**
 * `committedPipeline` reads the committed switch at push time; a test gives
 * the value that it checks.
 */
export function defineWorkspaceLinkUnlinkWorkflow(
  deps: { committedPipeline?: () => IngestionPublishPipeline } = {},
) {
  const committedPipeline = deps.committedPipeline ?? ingestionPublishPipeline
  return defineWorkflow(
    {
      name: "workspace-write-link-unlink",
      schema: workspaceLinkUnlinkInputSchema,
    },
    async ({ input: queuedInput, step, run }) => {
      const input = workspaceLinkUnlinkInputSchema.parse(queuedInput)
      // An unlink retracts while ingestion v2 publishes. The plan starts with
      // the queued value; the push step compares it with the committed value.
      const retracts = (pipeline: IngestionPublishPipeline) =>
        input.linkAction === "unlink" && pipeline === "v2"
      let planned = retracts(input.publishPipeline)
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
              publishPipeline: input.publishPipeline,
            }),
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
            const changes = await step.run(
              { name: "transform-link-unlink" },
              async () => {
                const declarations = changeLinkedRepository({
                  files: await readGitFiles(
                    acquired.pack,
                    isLinkedRepositoryDeclaration,
                  ),
                  action: input.linkAction,
                  gitUrl: input.linkGitUrl,
                })
                if (!planned) return declarations
                // While ingestion v2 publishes, the same commit retracts what
                // the repository owns (ADR-052 section 3).
                const retraction = await planUnlinkRetraction({
                  pack: acquired.pack,
                  sourceUrl: input.linkGitUrl,
                  workspaceRepositoryUrl: revision.remote.url,
                  observedAt: new Date(run.createdAt).toISOString(),
                })
                return {
                  files: [...declarations.files, ...retraction.files],
                  deletePaths: [
                    ...declarations.deletePaths,
                    ...retraction.deletePaths,
                  ],
                }
              },
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
              stageGitFiles(acquired.pack, files, changes.deletePaths),
            )
            await step.run({ name: "validate" }, () =>
              validateGitTree(staged, [
                ...files.map((file) => file.path),
                ...changes.deletePaths,
              ]),
            )
            const subject = await step.run({ name: "commit-subject" }, () =>
              generateCommitSubject({
                repoName: repositoryName.split("/")[1] ?? repositoryName,
                trigger: "link_unlink",
                fileNames: [
                  ...files.map((file) => file.path),
                  ...changes.deletePaths,
                ],
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
            let pushed:
              | Awaited<ReturnType<typeof attemptWorkspaceCommit>>
              | undefined
            for (;;) {
              const attempt = await step.run(
                { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
                async () => {
                  // The same step reads the switch and pushes, so no step
                  // runs between the check and the push.
                  if (retracts(committedPipeline()) !== planned)
                    return { replan: true as const }
                  return attemptWorkspaceCommit(input, revision, committed, env)
                },
              )
              if ("replan" in attempt) break
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
            if (!pushed?.pushed) {
              // The switch changed, or the default branch moved: plan again,
              // on the new tip. A semantic merge would push the old plan with
              // no new retraction and no check of the switch.
              await step.run({ name: "discard-unpublished-candidate" }, () =>
                discardWriteJobPreparedCommit(input.jobId, committed.sha),
              )
              if (pushed)
                revision = await step.run(
                  { name: "refresh-raced-revision" },
                  () => refreshWorkspaceWriteRevision(input, revision, env),
                )
              else planned = !planned
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
          throw new Error(
            "Default branch kept changing during no-op validation",
          )
        },
      )
    },
  )
}

export const workspaceLinkUnlink = defineWorkspaceLinkUnlinkWorkflow()
