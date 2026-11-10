import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import {
  IngestRefRefusedError,
  type WithheldFile,
} from "../../domain/ingestion/ingest-refs.js"
import {
  ingestSourceTree,
  releaseIngestSourceTree,
} from "../../domain/ingestion/ingest-source-tree.js"
import {
  capIngestText,
  logIngestEvent,
} from "../../domain/ingestion/ingest-telemetry.js"
import {
  retiredPublishPipelineField,
  workspacePublishPipeline,
} from "../../domain/ingestion/ingestion-v2-config.js"
import { sourceRepositoryUrls } from "../../domain/workspace-sources/providers/git.js"
import { parseSourceFile } from "../../domain/workspace-sources/source-file-text.js"
import { ingestPublishSourceSchema } from "../../domain/workspaces/extraction-source.js"
import { workspaceGitRead } from "../../domain/workspaces/resolve-revision.js"
import { workspaceRevisionSchema } from "../../domain/workspaces/revision.js"
import {
  resolveIngestConflicts,
  SemanticResolveError,
} from "../../domain/workspaces/semantic-merge.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import { packWorkspaceFormat } from "../../domain/workspaces/workspace-format-tree.js"
import {
  attemptWorkspaceCommit,
  mergeWorkspaceIngestPublish,
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
import {
  discardWriteJobPreparedCommit,
  getWriteJobUnchangedFiles,
  persistBoundWriteJob,
  persistWriteJobUnchangedFiles,
} from "../../models/workspace-write-jobs.js"
import { persistWriteJobStatus } from "../../models/workspaces.js"
import {
  type GitRemoteRead,
  type GitWriteCommit,
  readGitFiles,
  writeCommitPack,
} from "../../services/git/pack.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { runJobRefStep } from "../write-steps.js"
import { workspaceHydrate } from "./workspace-hydrate.js"

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
    /**
     * Retired: the capture of the old pipeline. A job that was
     * queued with it still parses, and it ends with no write.
     */
    extraction: z.record(z.string(), z.unknown()).optional(),
    /**
     * Ingestion v2 (ADR-052 section 6, T21): the assembled ref tip of a run.
     * `revision.sha` is the run's pinned revision.
     */
    ingest: ingestPublishSourceSchema.optional(),
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
  .refine(
    (input) =>
      (input.extraction === undefined) !== (input.ingest === undefined),
    "An extraction or an ingestion v2 source is required, not both",
  )

/**
 * The result of a publish. `withheld` names the merged files that the
 * publish left at the default-branch version because they failed the patch
 * validator (CTX-1081).
 */
type ExtractIngestResult = (
  | { committed: true; commitSha: string }
  | {
      committed: false
      reason:
        | "legacy_ingestion_retired"
        | "no_changes"
        | "source_unlinked"
        | "publish_pipeline_stopped"
    }
  | {
      committed: false
      reason: "refused"
      // A step output is JSON: its fields are optional.
      refused?: string
      rules?: IngestRefRefusedError["rules"]
    }
  | { committed: false; reason: "failed"; failed?: string }
) & { withheld?: WithheldFile[] }

/**
 * The Workspace format is the switch (ADR-052 phase 4, G5): an ingestion v2
 * publish (`ingest`) pushes only on a tree where the format selects `v2`.
 * The check reads the format file of the tree that the job pushes on, so a
 * job that was queued before a revert of the upgrade stops. A job of the
 * retired old pipeline (`extraction`) ends with no write.
 */
export function defineWorkspaceExtractIngestWorkflow() {
  return defineWorkflow(
    {
      name: "workspace-write-extract-ingest",
      schema: workspaceExtractIngestInputSchema,
    },
    async ({ input: queuedInput, step, run }): Promise<ExtractIngestResult> => {
      const input = workspaceExtractIngestInputSchema.parse(queuedInput)
      const pipelineStopped = async (
        committed: GitWriteCommit,
        read: GitRemoteRead,
      ) =>
        workspacePublishPipeline(
          await packWorkspaceFormat(writeCommitPack(committed, read.url), read),
        ) !== "v2"
      // An ingestion v2 publish needs its source file in the tree that it
      // pushes on, and the file must still name the source repository. Else
      // the repository was unlinked while the run was in flight.
      const sourceUnlinked = async (
        committed: GitWriteCommit,
        read: GitRemoteRead,
      ) => {
        if (!input.ingest) return false
        const { sourcePath, source } = input.ingest
        const [file] = await readGitFiles(
          writeCommitPack(committed, read.url),
          (path) => path === sourcePath,
          undefined,
          read,
        )
        if (!file || file.omitted) return true
        const parsed = parseSourceFile(file.path, file.content)
        return (
          !parsed.ok ||
          !sourceRepositoryUrls(parsed.source).includes(
            normalizeWorkspaceRepositoryUrl(source.url),
          )
        )
      }
      return withWorkspaceWriteContext(
        input,
        "workspace-write-extract-ingest",
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
            "extract_ingest",
            run.id,
          )
          if (completed) return completed
          const ingestSource = input.ingest
          if (!ingestSource) {
            // The old pipeline is gone: no ingestion writes to a
            // Workspace below format 3. A job that it queued ends here.
            await step.run({ name: "complete-retired" }, () =>
              persistWriteJobStatus(
                input.jobId,
                "completed",
                "The old ingestion pipeline is retired. Its queued extract_ingest job ends with no write; ingestion v2 publishes to a Workspace at format 3 or more.",
              ),
            )
            return {
              committed: false as const,
              reason: "legacy_ingestion_retired" as const,
            }
          }
          // The merged files that fail the patch validator, from the job: the
          // step that merged them recorded them there (CTX-1239).
          const withheldFiles = async () => {
            const { withheld } = await getWriteJobUnchangedFiles(input.jobId)
            return withheld?.length ? withheld : undefined
          }
          await step.run({ name: "claim-command" }, () =>
            persistBoundWriteJob({
              id: input.jobId,
              kind: "extract_ingest",
              revision: input.revision,
              workflowRunId: run.id,
              ingest: ingestSource,
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
            // One step merges the run onto the tip, commits the result, and
            // pushes the commit to its job ref: no step output holds a file
            // (CTX-1239).
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
                      const { source, sourcePath, sourceSha, ...ingest } =
                        ingestSource
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
                        const merged = await mergeWorkspaceIngestPublish(
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
                              sourcePath,
                              sourcePathExists: (path) =>
                                sourceTree().exists(path),
                              readSourceFile: (path) => sourceTree().read(path),
                            },
                          },
                          env,
                        )
                        const { withheldReasons, ...output } = merged
                        if (merged.withheld.length)
                          logIngestEvent("warn", "ingestion-v2.partial", {
                            ingestionRunId: ingest.runId,
                            ingestStep: "publish",
                            workspaceId: input.workspaceId,
                            // Fixed codes and a count: a path can hold model text.
                            reason: "withheld",
                            rules: [
                              ...new Set(
                                merged.withheld.flatMap((w) => w.rules),
                              ),
                            ].sort(),
                            withheld: merged.withheld.length,
                          })
                        // Log the validator reasons of the withheld files as the step
                        // rejections log them, with a count and no path (CTX-1099).
                        for (const { rule, reason, files } of withheldReasons)
                          logIngestEvent(
                            "warn",
                            "ingestion-v2.publish-withheld",
                            {
                              ingestionRunId: ingest.runId,
                              workspaceId: input.workspaceId,
                              rule,
                              reason: capIngestText(reason),
                              files,
                            },
                          )
                        // The list of withheld files can be long: the job keeps it,
                        // not the step output (CTX-1239).
                        await persistWriteJobUnchangedFiles(input.jobId, {
                          withheld: output.withheld,
                        })
                        return {
                          files: output.files,
                          deletePaths: output.deletePaths,
                        }
                      } catch (error) {
                        // A refused publish (not a validator rejection of a
                        // merged file, which is withheld): the Workspace is
                        // `partial`, and the publish writes nothing.
                        if (error instanceof IngestRefRefusedError) {
                          logIngestEvent("warn", "ingestion-v2.partial", {
                            ingestionRunId: ingest.runId,
                            ingestStep: "publish",
                            workspaceId: input.workspaceId,
                            // Fixed codes: the cause text can hold model or
                            // customer text.
                            reason: "refused",
                            rules: error.rules,
                          })
                          return {
                            stopped: "refused" as const,
                            refused: error.message.slice(0, 300),
                            rules: error.rules,
                          }
                        }
                        // A failed semantic merge model: the same, but the run
                        // keeps the refs.
                        if (error instanceof SemanticResolveError) {
                          logIngestEvent("warn", "ingestion-v2.partial", {
                            ingestionRunId: ingest.runId,
                            ingestStep: "publish",
                            workspaceId: input.workspaceId,
                            reason: "failed",
                          })
                          return {
                            stopped: "failed" as const,
                            failed: error.message.slice(0, 300),
                          }
                        }
                        throw error
                      } finally {
                        await releaseIngestSourceTree(
                          ingest.runId,
                          sourceSha,
                          holder,
                        )
                      }
                    },
                    // A fixed message: the same run makes the same commit.
                    subject: `Update extracted knowledge\n\nCtxpipe-Run: ${ingestSource.runId}`,
                    // A replay of a publish is a new workflow run: the run's
                    // author time keeps the SHA.
                    createdAt: new Date(ingestSource.authorTime),
                  },
                  env,
                ),
            )
            if (committed && "stopped" in committed) {
              await step.run(
                {
                  name:
                    committed.stopped === "refused"
                      ? "refuse-publish"
                      : "fail-publish",
                },
                () => persistWriteJobStatus(input.jobId, "failed"),
              )
              return committed.stopped === "refused"
                ? {
                    committed: false as const,
                    reason: "refused" as const,
                    refused: committed.refused,
                    rules: committed.rules,
                  }
                : {
                    committed: false as const,
                    reason: "failed" as const,
                    failed: committed.failed,
                  }
            }
            if (!committed) {
              // The delta is from the pinned revision, so a later tip cannot
              // add to it: there is nothing to confirm.
              await step.run({ name: "complete-no-op" }, () =>
                persistWriteJobStatus(input.jobId, "completed"),
              )
              return {
                committed: false as const,
                reason: "no_changes" as const,
                withheld: await withheldFiles(),
              }
            }
            let pushed: Awaited<ReturnType<typeof attemptWorkspaceCommit>>
            for (;;) {
              const attempt = await step.run(
                { name: "broker-push", retryPolicy: { maximumAttempts: 3 } },
                async () => {
                  // The format can change after the transform and while the
                  // push waits for write access. The step that pushes reads
                  // it from the tree that it pushes on: the push lands only
                  // on that parent, so no other tree can get the commit.
                  if (await pipelineStopped(committed, read)) {
                    // The job publishes nothing, so it keeps no commit.
                    await discardWriteJobPreparedCommit(
                      input.jobId,
                      committed.sha,
                    )
                    await persistWriteJobStatus(input.jobId, "completed")
                    return { stopped: true as const }
                  }
                  if (await sourceUnlinked(committed, read)) {
                    await discardWriteJobPreparedCommit(
                      input.jobId,
                      committed.sha,
                    )
                    await persistWriteJobStatus(input.jobId, "completed")
                    return { unlinked: true as const }
                  }
                  return attemptWorkspaceCommit(input, revision, committed, env)
                },
              )
              if ("unlinked" in attempt)
                return {
                  committed: false as const,
                  reason: "source_unlinked" as const,
                }
              if ("stopped" in attempt)
                return {
                  committed: false as const,
                  reason: "publish_pipeline_stopped" as const,
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
            if (!pushed.pushed) {
              // The default branch moved: replay the delta on the new tip. A
              // semantic merge handoff would push a merge that no validator saw.
              await step.run({ name: "discard-unpublished-candidate" }, () =>
                discardWriteJobPreparedCommit(input.jobId, committed.sha),
              )
              revision = await step.run(
                { name: "refresh-raced-revision" },
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
                { idempotencyKey: extractionHydrateKey(input.jobId) },
              )
            })
            await step.run({ name: "complete" }, () =>
              completeWorkspaceWrite(
                { ...input, remote: input.revision.remote },
                committed.sha,
                env,
              ),
            )
            return {
              committed: true as const,
              commitSha: committed.sha,
              withheld: await withheldFiles(),
            }
          }
          // Each attempt lost the push race: publish nothing, and let the
          // run publish its other Workspaces.
          await step.run({ name: "fail-raced-publish" }, async () => {
            logIngestEvent("warn", "ingestion-v2.partial", {
              ingestionRunId: ingestSource.runId,
              ingestStep: "publish",
              workspaceId: input.workspaceId,
              reason: "failed",
            })
            await persistWriteJobStatus(input.jobId, "failed")
          })
          return {
            committed: false as const,
            reason: "failed" as const,
            failed: "The default branch kept changing during the publish",
          }
        },
      )
    },
  )
}

export const workspaceExtractIngest = defineWorkspaceExtractIngestWorkflow()
