import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { isConnectorMirrorPath } from "../../domain/codeIngestion/connectorMirrorPaths.js"
import { IngestRefRefusedError } from "../../domain/ingestion/ingest-refs.js"
import {
  ingestSourceTree,
  releaseIngestSourceTree,
} from "../../domain/ingestion/ingest-source-tree.js"
import {
  type IngestionPublishPipeline,
  ingestionPublishPipeline,
  ingestionPublishPipelineSchema,
  publishPipelineStopped,
} from "../../domain/ingestion/ingestion-v2-config.js"
import { planStoredExtraction } from "../../domain/workspaces/captured-extraction.js"
import { generateCommitSubject } from "../../domain/workspaces/commit-subject.js"
import { workspaceExtractionSchema } from "../../domain/workspaces/extraction.js"
import { ingestPublishSourceSchema } from "../../domain/workspaces/extraction-source.js"
import { isLinkedRepositoryDeclaration } from "../../domain/workspaces/layout.js"
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import {
  resolveIngestConflicts,
  SemanticResolveError,
} from "../../domain/workspaces/semantic-merge.js"
import {
  attemptWorkspaceCommit,
  captureSemanticHandoff,
  mergeWorkspaceIngestPublish,
  publishWorkspaceWriteRevision,
  refreshWorkspaceWriteRevision,
} from "../../domain/workspaces/write-broker.js"
import {
  acquireWorkspaceWriteRevision,
  completedWorkspaceWrite,
  withWorkspaceWriteContext,
} from "../../domain/workspaces/write-command.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { loadExtractionPathIdentity } from "../../models/workspace-export.js"
import {
  discardWriteJobPreparedCommit,
  persistBoundWriteJob,
  persistWriteJobKnowledgePaths,
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

/** Native idempotency key of the hydrate an extraction write job admits after publishing. */
export function extractionHydrateKey(jobId: string): string {
  return `${jobId}:hydrate`
}

export const workspaceExtractIngestInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
    /** The old pipeline: a stored extraction capture. */
    extraction: workspaceExtractionSchema.optional(),
    /**
     * Ingestion v2 (ADR-052 section 6, T21): the assembled ref tip of a run.
     * `revision.sha` is the run's pinned revision.
     */
    ingest: ingestPublishSourceSchema.optional(),
    /**
     * The publish pipeline when the job was queued (ADR-052 phase 4). A job
     * queued before this field is `legacy`.
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
  .refine(
    (input) =>
      (input.extraction === undefined) !== (input.ingest === undefined),
    "An extraction or an ingestion v2 source is required, not both",
  )

/**
 * `committedPipeline` reads the committed switch at push time; a test gives
 * the value that it checks.
 */
export function defineWorkspaceExtractIngestWorkflow(
  deps: { committedPipeline?: () => IngestionPublishPipeline } = {},
) {
  const committedPipeline = deps.committedPipeline ?? ingestionPublishPipeline
  return defineWorkflow(
    {
      name: "workspace-write-extract-ingest",
      schema: workspaceExtractIngestInputSchema,
    },
    async ({ input: queuedInput, step, run }) => {
      const input = workspaceExtractIngestInputSchema.parse(queuedInput)
      // A job queued before a switch, or a job of the other pipeline, stops.
      const pipelineStopped = () =>
        publishPipelineStopped({
          job: input.ingest ? "v2" : "legacy",
          queued: input.publishPipeline,
          committed: committedPipeline(),
        })
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
              extraction: input.extraction,
              ingest: input.ingest,
              publishPipeline: input.publishPipeline,
            }),
          )
          const identity = input.extraction
            ? await step.run({ name: "load-extraction-path-identity" }, () =>
                loadExtractionPathIdentity(input.revision),
              )
            : null
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
              { name: "transform-extract-ingest" },
              async () => {
                if (input.ingest) {
                  const { source, sourceSha, ...ingest } = input.ingest
                  // Its own copy of the source tree, for the validator.
                  const holder = `publish:${input.workspaceId}`
                  const sourceTree = () =>
                    ingestSourceTree({
                      orgId: input.orgId,
                      runId: ingest.runId,
                      source,
                      sha: sourceSha,
                      env,
                      holder,
                    })
                  try {
                    return {
                      ...(await mergeWorkspaceIngestPublish(
                        {
                          orgId: input.orgId,
                          workspaceId: input.workspaceId,
                          runId: ingest.runId,
                          pinnedRevision: input.revision.sha,
                          tip: ingest.tip,
                          current: revision.sha,
                          withheldRoots: ingest.withheldRoots,
                          bundle: ingest.bundle,
                          semanticMerge: {
                            resolve: resolveIngestConflicts,
                            source: { url: source.url, sha: sourceSha },
                            sourcePathExists: (path) =>
                              sourceTree().exists(path),
                            readSourceFile: (path) => sourceTree().read(path),
                          },
                        },
                        env,
                      )),
                      knowledgePaths: {} as Record<string, string>,
                    }
                  } catch (error) {
                    // A merge that fails the patch validator: the Workspace
                    // is `partial`, and the publish writes nothing.
                    if (error instanceof IngestRefRefusedError)
                      return { refused: error.message.slice(0, 300) }
                    // A failed semantic merge model: the same, but the run
                    // keeps the refs.
                    if (error instanceof SemanticResolveError)
                      return {
                        failed: error.message.slice(0, 300),
                      }
                    throw error
                  } finally {
                    await releaseIngestSourceTree(
                      ingest.runId,
                      sourceSha,
                      holder,
                    )
                  }
                }
                // A job of the old pipeline that was queued or paused before
                // the switch to ingestion v2 must not publish (ADR-052 phase 4).
                if (pipelineStopped()) return { stopped: true as const }
                if (!input.extraction || !identity)
                  throw new Error("The extraction command has no capture")
                const extraction = input.extraction
                const existingKnowledge = await readGitFiles(
                  acquired.pack,
                  (path) =>
                    path.endsWith(".md") && !isConnectorMirrorPath(path),
                )
                const plan = await planStoredExtraction({
                  ...identity,
                  orgId: input.orgId,
                  extraction,
                  workspaceId: input.workspaceId,
                  workspaceRepositoryUrl: revision.remote.url,
                  existingKnowledge,
                })
                const existing = new Map(
                  existingKnowledge.map((file) => [file.path, file.content]),
                )
                const files = plan.files.filter(
                  (file) =>
                    !file.path.startsWith(".agents/") &&
                    (!isLinkedRepositoryDeclaration(file.path) ||
                      file.path === extraction.sourceDeclaration?.path) &&
                    !isConnectorMirrorPath(file.path) &&
                    existing.get(file.path) !== file.content,
                )
                return {
                  files,
                  deletePaths: [] as string[],
                  knowledgePaths: plan.knowledgePaths,
                }
              },
            )
            if ("stopped" in transformed) {
              await step.run({ name: "complete-stopped" }, () =>
                persistWriteJobStatus(input.jobId, "completed"),
              )
              return {
                committed: false as const,
                reason: "publish_pipeline_v2" as const,
              }
            }
            if ("refused" in transformed) {
              await step.run({ name: "refuse-publish" }, () =>
                persistWriteJobStatus(input.jobId, "failed"),
              )
              return {
                committed: false as const,
                reason: "refused" as const,
                refused: transformed.refused,
              }
            }
            if ("failed" in transformed) {
              await step.run({ name: "fail-publish" }, () =>
                persistWriteJobStatus(input.jobId, "failed"),
              )
              return {
                committed: false as const,
                reason: "failed" as const,
                failed: transformed.failed,
              }
            }
            if (input.extraction)
              await step.run({ name: "record-knowledge-paths" }, () =>
                persistWriteJobKnowledgePaths(
                  input.jobId,
                  transformed.knowledgePaths,
                ),
              )
            const { files, deletePaths } = transformed
            if (!files.length && !deletePaths.length && input.ingest) {
              // The delta is from the pinned revision, so a later tip cannot
              // add to it: there is nothing to confirm.
              await step.run({ name: "complete-no-op" }, () =>
                persistWriteJobStatus(input.jobId, "completed"),
              )
              return {
                committed: false as const,
                reason: "no_changes" as const,
              }
            }
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
            const staged = await step.run({ name: "stage" }, () =>
              stageGitFiles(acquired.pack, files, deletePaths),
            )
            await step.run({ name: "validate" }, () =>
              validateGitTree(staged, [
                ...files.map((file) => file.path),
                ...deletePaths,
              ]),
            )
            const subject = await step.run(
              { name: "commit-subject" },
              async () =>
                input.ingest
                  ? // A fixed message: the same run makes the same commit.
                    `Update extracted knowledge\n\nCtxpipe-Run: ${input.ingest.runId}`
                  : generateCommitSubject({
                      repoName: repositoryName.split("/")[1] ?? repositoryName,
                      trigger: "extract_ingest",
                      fileNames: files.map((file) => file.path),
                    }),
            )
            const committed = await step.run({ name: "commit" }, async () => {
              const pack = await commitGitTree(staged, {
                subject,
                // A replay of a publish is a new workflow run: the run's
                // author time keeps the SHA.
                createdAt: input.ingest
                  ? new Date(input.ingest.authorTime)
                  : run.createdAt,
              })
              await persistWriteJobPreparedCommit(input.jobId, pack.sha)
              return pack
            })
            let pushed: Awaited<ReturnType<typeof attemptWorkspaceCommit>>
            for (;;) {
              const attempt = await step.run(
                { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
                async () => {
                  // The switch can change after the transform and while the
                  // push waits for write access. The step that pushes reads
                  // it immediately before the push, so no step runs between.
                  // Each pipeline pushes only while the switch selects it.
                  if (pipelineStopped()) {
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
                  reason: input.ingest
                    ? ("publish_pipeline_legacy" as const)
                    : ("publish_pipeline_v2" as const),
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
            if (!pushed.pushed && input.ingest) {
              // The default branch moved: replay the delta on the new tip.
              // The handoff below would push a merge that no validator saw.
              await step.run({ name: "discard-unpublished-candidate" }, () =>
                discardWriteJobPreparedCommit(input.jobId, committed.sha),
              )
              revision = await step.run(
                { name: "refresh-raced-revision" },
                () => refreshWorkspaceWriteRevision(input, revision, env),
              )
              continue
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
                { idempotencyKey: extractionHydrateKey(input.jobId) },
              )
            })
            await step.run({ name: "complete" }, () =>
              persistWriteJobCommitSha(input.jobId, committed.sha),
            )
            return { committed: true as const, commitSha: committed.sha }
          }
          if (input.ingest) {
            // Each attempt lost the push race: publish nothing, and let the
            // run publish its other Workspaces.
            await step.run({ name: "fail-raced-publish" }, () =>
              persistWriteJobStatus(input.jobId, "failed"),
            )
            return {
              committed: false as const,
              reason: "failed" as const,
              failed: "The default branch kept changing during the publish",
            }
          }
          throw new Error(
            "Default branch kept changing during no-op validation",
          )
        },
      )
    },
  )
}

export const workspaceExtractIngest = defineWorkspaceExtractIngestWorkflow()
