import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { resolveRepositoryRef } from "../../domain/codeIngestion/queue.js"
import { isRepositoryGoneError } from "../../domain/codeIngestion/repositoryGone.js"
import { deduplicateAndStore } from "../../graphs/codeIngestionGraph/nodes/deduplicateAndStore.js"
import { embed } from "../../graphs/codeIngestionGraph/nodes/embed.js"
import { identifyRoots } from "../../graphs/codeIngestionGraph/nodes/identifyRoots.js"
import { project } from "../../graphs/codeIngestionGraph/nodes/project.js"
import { retractStaleEvidence } from "../../graphs/codeIngestionGraph/nodes/retractStaleEvidence.js"
import {
  finalizeExtractedReferences,
  runExtractKindForRoot,
  runIdentifyPhaseForRoot,
  stableRootStepId,
} from "../../graphs/codeIngestionGraph/runExtractRoot.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../../graphs/codeIngestionGraph/schemas.js"
import { withIngestAgentContext } from "../../graphs/codeIngestionGraph/withIngestAgentContext.js"
import {
  markRepositoryIndexingReady,
  markRepositoryIndexingReadyWithIssues,
  markRepositoryIndexingRunning,
  repositoryIngestionBlockedByDeletion,
  setRepositoryIndexingStep,
} from "../../models/repositories.js"
import { readAttribution } from "../../observability/attribution.js"
import { attachJobTelemetry } from "../../observability/jobTelemetry.js"
import {
  runWithLangfuseContext,
  withLangfuseObservation,
} from "../../observability/langfuse.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import {
  applyIngestionRetractionGraphEffects,
  retractUnobservedRepositoryEvidencePg,
} from "../../retrieval/services/ingestionRetraction.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { enqueueFollowUpIfTipAhead } from "../enqueue-follow-up-if-tip-ahead.js"
import { withLoggedStepAttempt } from "../withLoggedStepAttempt.js"
import { repositoryIndex } from "./repository-index.js"

const repositoryIngestionInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetBranch: z.string().nullable().optional(),
  /** Stored on the row while ingestion runs; cleared on success. */
  indexingReason: z.string().nullable().optional(),
  /** Checkpointed with connector writes so replay cannot switch installations. */
  githubConnectionId: z.string().nullable().optional(),
  /** Ignore the last ingested commit: full codesearch mode plus the unobserved-evidence sweep. */
  fullReingest: z.boolean().optional(),
})

const REPOSITORY_INGESTION_STOPPED = {
  repositoryIngestionStopped: true,
} as const

class IngestionAborted extends Error {
  constructor() {
    super("repository ingestion stopped because the repository was deleted")
    this.name = "IngestionAborted"
  }
}

function isIngestionStopped(
  value: unknown,
): value is typeof REPOSITORY_INGESTION_STOPPED {
  return (
    typeof value === "object" &&
    value !== null &&
    "repositoryIngestionStopped" in value &&
    (value as { repositoryIngestionStopped?: unknown })
      .repositoryIngestionStopped === true
  )
}

function continueIngestion<T>(
  value: T,
): Exclude<T, typeof REPOSITORY_INGESTION_STOPPED> {
  if (isIngestionStopped(value)) throw new IngestionAborted()
  return value as Exclude<T, typeof REPOSITORY_INGESTION_STOPPED>
}

const extractRetryPolicy = {
  maximumAttempts: 3,
  initialInterval: "30s" as const,
  backoffCoefficient: 2,
  maximumInterval: "2m" as const,
}

/** Milestone log inside `withLogger` — uses getLogger + immediate emit. */
function logWorkflowMilestone(
  step: string,
  fields: Record<string, unknown>,
): void {
  const l = getLogger()
  l.set({
    step,
    component: "openworkflow-worker",
    at: new Date().toISOString(),
    pid: process.pid,
    ...fields,
  })
  l.info(step)
  flushWorkflowLog()
}

export const repositoryIngestion = defineWorkflow(
  { name: "repository-ingestion", schema: repositoryIngestionInputSchema },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "repository-ingestion",
        repositoryId: input.repositoryId,
        orgId: input.orgId,
      }),
      async () => {
        const wls = async <T>(
          name: string,
          fn: () => Promise<T>,
        ): Promise<T | typeof REPOSITORY_INGESTION_STOPPED> =>
          withLoggedStepAttempt(
            name,
            {
              workflow: "repository-ingestion",
              repositoryId: input.repositoryId,
              orgId: input.orgId,
            },
            async () => {
              if (
                await repositoryIngestionBlockedByDeletion({
                  orgId: input.orgId,
                  repositoryId: input.repositoryId,
                })
              ) {
                logWorkflowMilestone("repository-ingestion.stopped", {
                  repositoryId: input.repositoryId,
                  orgId: input.orgId,
                  stepName: name,
                  reason: "repository_deleted",
                })
                return REPOSITORY_INGESTION_STOPPED
              }
              try {
                return await fn()
              } catch (err: unknown) {
                if (!isRepositoryGoneError(err)) throw err
                logWorkflowMilestone("repository-ingestion.stopped", {
                  repositoryId: input.repositoryId,
                  orgId: input.orgId,
                  stepName: name,
                  reason: "codesearch_repository_gone",
                })
                return REPOSITORY_INGESTION_STOPPED
              }
            },
          )

        logWorkflowMilestone("repository-ingestion.workflow-handler-entered", {
          repositoryId: input.repositoryId,
          orgId: input.orgId,
          targetBranch: input.targetBranch ?? null,
          indexingReason: input.indexingReason ?? null,
        })

        logWorkflowMilestone("repository-ingestion.start", {
          repositoryId: input.repositoryId,
          orgId: input.orgId,
        })

        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })

        if (!org) {
          throw new Error(`Organization not found: ${input.orgId}`)
        }

        return await withOrgIdContext(
          { id: org.id, slug: org.slug },
          async () => {
            try {
              const durableRun = step.run.bind(step)
              const runStep = async <T>(
                opts: {
                  name: string
                  retryPolicy?: {
                    maximumAttempts: number
                    initialInterval: string
                    backoffCoefficient: number
                    maximumInterval: string
                  }
                },
                fn: () => Promise<T>,
              ): Promise<Exclude<T, typeof REPOSITORY_INGESTION_STOPPED>> => {
                const result = await durableRun(
                  opts as Parameters<typeof step.run>[0],
                  fn as Parameters<typeof step.run>[1],
                )
                return continueIngestion(result as T)
              }

              await runStep({ name: "mark-running" }, () =>
                wls("mark-running", () =>
                  withOrgDbContext(input.orgId, () =>
                    markRepositoryIndexingRunning({
                      repositoryId: input.repositoryId,
                    }),
                  ),
                ),
              )

              logWorkflowMilestone(
                "repository-ingestion.step.get-repository.start",
                {
                  repositoryId: input.repositoryId,
                  orgId: input.orgId,
                },
              )

              const repository = await runStep({ name: "get-repository" }, () =>
                wls("get-repository", () =>
                  withOrgDbContext(input.orgId, (db) =>
                    db.query.repositories.findFirst({
                      where: {
                        id: { eq: input.repositoryId },
                        orgId: { eq: input.orgId },
                      },
                    }),
                  ),
                ),
              )

              logWorkflowMilestone(
                "repository-ingestion.step.get-repository.done",
                {
                  repositoryId: input.repositoryId,
                  found: Boolean(repository),
                },
              )

              if (!repository) {
                throw new Error(
                  `repository-ingestion: no repository row for id=${input.repositoryId} orgId=${input.orgId} (skipping codesearch resolve-ref)`,
                )
              }

              const githubConnectionId =
                input.githubConnectionId ?? repository.githubConnectionId
              // A requested full re-ingest ignores the last ingested commit, so
              // codesearch runs in full mode and the unobserved-evidence sweep applies.
              const fromHash = input.fullReingest
                ? undefined
                : (repository.lastIngestedHash ?? undefined)
              logWorkflowMilestone("repository-ingestion.repository-loaded", {
                repositoryId: input.repositoryId,
                lastIngestedHash: repository.lastIngestedHash,
                fullReingest: input.fullReingest ?? false,
                githubConnectionId,
              })

              await runStep({ name: "set-step-resolving-ref" }, () =>
                wls("set-step-resolving-ref", () =>
                  withOrgDbContext(input.orgId, () =>
                    setRepositoryIndexingStep({
                      repositoryId: input.repositoryId,
                      key: "resolving_ref",
                    }),
                  ),
                ),
              )

              logWorkflowMilestone(
                "repository-ingestion.step.resolve-ref.start",
                {
                  repositoryId: input.repositoryId,
                  branch: input.targetBranch ?? null,
                },
              )

              const resolved = await runStep({ name: "resolve-ref" }, () =>
                wls("resolve-ref", () =>
                  resolveRepositoryRef({
                    repositoryId: input.repositoryId,
                    orgId: input.orgId,
                    branch: input.targetBranch ?? undefined,
                    githubConnectionId,
                  }),
                ),
              )

              logWorkflowMilestone(
                "repository-ingestion.step.resolve-ref.done",
                {
                  repositoryId: input.repositoryId,
                  targetHash: resolved.hash,
                  branch: resolved.branch,
                },
              )

              logWorkflowMilestone("repository-ingestion.ref-resolved", {
                targetHash: resolved.hash,
                sourceBranch: resolved.branch,
              })

              logWorkflowMilestone("repository-ingestion.step.reindex.start", {
                repositoryId: input.repositoryId,
                targetHash: resolved.hash,
              })

              // Durable codesearch phases via child workflow (no org DB txn across HTTP).
              // A delete cancels this child; that failure is a clean stop, not an outage.
              const reindexState = await (async () => {
                try {
                  return await step.runWorkflow(
                    repositoryIndex.spec,
                    attachJobTelemetry({
                      repositoryId: input.repositoryId,
                      orgId: input.orgId,
                      targetHash: resolved.hash,
                      ...(fromHash ? { fromHash } : {}),
                      ...(githubConnectionId ? { githubConnectionId } : {}),
                    }),
                    { name: "repository-index" },
                  )
                } catch (err: unknown) {
                  if (
                    await repositoryIngestionBlockedByDeletion({
                      orgId: input.orgId,
                      repositoryId: input.repositoryId,
                    })
                  ) {
                    throw new IngestionAborted()
                  }
                  throw err
                }
              })()

              logWorkflowMilestone("repository-ingestion.step.reindex.done", {
                repositoryId: input.repositoryId,
                targetHash: reindexState.targetHash ?? resolved.hash,
                ingestMode: reindexState.ingestMode,
                searchIndexOk: reindexState.searchIndexOk !== false,
                scipIndexOk: reindexState.scipIndexOk !== false,
                changedPathsCount: reindexState.changedPaths?.length ?? 0,
                deletedPathsCount: reindexState.deletedPaths?.length ?? 0,
                renamesCount: reindexState.renames?.length ?? 0,
              })

              logWorkflowMilestone(
                "repository-ingestion.step.retraction.start",
                {
                  repositoryId: input.repositoryId,
                  targetHash: reindexState.targetHash ?? resolved.hash,
                  ingestMode: reindexState.ingestMode,
                },
              )

              await runStep({ name: "set-step-retracting" }, () =>
                wls("set-step-retracting", () =>
                  withOrgDbContext(input.orgId, () =>
                    setRepositoryIndexingStep({
                      repositoryId: input.repositoryId,
                      key: "retracting",
                    }),
                  ),
                ),
              )

              const retractionResult = await runStep(
                { name: "retractionStep" },
                () =>
                  wls("retractionStep", () =>
                    withOrgDbContext(input.orgId, () =>
                      retractStaleEvidence({
                        orgId: input.orgId,
                        repositoryId: input.repositoryId,
                        targetHash: reindexState.targetHash ?? resolved.hash,
                        ingestMode: reindexState.ingestMode,
                        changedPaths: reindexState.changedPaths,
                        deletedPaths: reindexState.deletedPaths,
                        renames: reindexState.renames,
                      }),
                    ),
                  ),
              )

              logWorkflowMilestone(
                "repository-ingestion.step.retraction.done",
                {
                  repositoryId: input.repositoryId,
                  targetHash: reindexState.targetHash ?? resolved.hash,
                  retractionStats: retractionResult.retractionStats,
                },
              )

              logWorkflowMilestone("repository-ingestion.step.ingest.start", {
                repositoryId: input.repositoryId,
                targetHash: reindexState.targetHash ?? resolved.hash,
              })

              const baseIngestState: CodeIngestionState = {
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                githubConnectionId: githubConnectionId ?? undefined,
                fromHash,
                targetHash: reindexState.targetHash ?? resolved.hash,
                indexedAt: reindexState.indexedAt,
                ingestMode: reindexState.ingestMode,
                changedPaths: reindexState.changedPaths,
                deletedPaths: reindexState.deletedPaths,
                renames: reindexState.renames,
                roots: [],
                extractedObjects: [],
                extractedClaims: [],
                objectIds: [],
                touchedObjectIds: [],
                claimsForProjection: [],
              }

              const workflowRunId = run?.id ?? "unknown"
              const ingestionRunId = `repository-ingestion:${workflowRunId}`
              const baseLangfuseMetadata = {
                workflow: "repository-ingestion",
                ingestionRunId,
                workflowRunId,
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                targetHash: baseIngestState.targetHash,
                fromHash: baseIngestState.fromHash ?? null,
                ingestMode: baseIngestState.ingestMode ?? null,
                rootId: null,
                root: null,
              }
              const actorUserId = readAttribution()["enduser.id"]
              const langfuseAttrs = {
                sessionId: ingestionRunId,
                ...(actorUserId ? { userId: actorUserId } : {}),
                tags: ["repository-ingestion"],
                traceMetadata: baseLangfuseMetadata,
              }

              const extractResult = await runWithLangfuseContext(
                langfuseAttrs,
                async () => {
                  const rootsPartial = await runStep(
                    { name: "identify-roots", retryPolicy: extractRetryPolicy },
                    () =>
                      wls("identify-roots", () =>
                        withLangfuseObservation(
                          {
                            name: "repository-ingestion.identify-roots",
                            input: {
                              repositoryId: input.repositoryId,
                              targetHash: baseIngestState.targetHash,
                            },
                            metadata: {
                              ...baseLangfuseMetadata,
                              workflowStepName: "identify-roots",
                              rootId: null,
                              root: null,
                            },
                          },
                          () =>
                            withIngestAgentContext(
                              {
                                ...langfuseAttrs,
                                runName: "repository-ingestion.identify-roots",
                                metadata: {
                                  workflowStepName: "identify-roots",
                                  rootId: null,
                                  root: null,
                                },
                              },
                              () => identifyRoots(baseIngestState),
                            ),
                        ),
                      ),
                  )

                  const roots = rootsPartial.roots ?? []
                  logWorkflowMilestone(
                    "repository-ingestion.step.identify-roots.done",
                    {
                      repositoryId: input.repositoryId,
                      rootsCount: roots.length,
                      roots,
                    },
                  )

                  const rootExtractResults = await Promise.all(
                    roots.map(async (root) => {
                      const rootId = stableRootStepId(root)
                      const kindPartial = await runStep(
                        {
                          name: `extract-kind:${rootId}`,
                          retryPolicy: extractRetryPolicy,
                        },
                        () =>
                          wls(`extract-kind:${rootId}`, () =>
                            withLangfuseObservation(
                              {
                                name: "repository-ingestion.extract-kind",
                                input: { rootId, root },
                                metadata: {
                                  ...baseLangfuseMetadata,
                                  workflowStepName: `extract-kind:${rootId}`,
                                  rootId,
                                  root,
                                },
                              },
                              () =>
                                withIngestAgentContext(
                                  {
                                    ...langfuseAttrs,
                                    runName:
                                      "repository-ingestion.extract-kind",
                                    metadata: {
                                      workflowStepName: `extract-kind:${rootId}`,
                                      rootId,
                                      root,
                                    },
                                  },
                                  () =>
                                    runExtractKindForRoot(
                                      baseIngestState,
                                      root,
                                    ),
                                ),
                            ),
                          ),
                      )

                      // Coarsen identify_* into one durable step per root (kind
                      // boundary stays durable). Avoids WORKFLOW_STEP_LIMIT blowups
                      // on large monorepos while preserving extractKind-before-
                      // identify ordering and cross-root parallelism.
                      return runStep(
                        {
                          name: `identify:${rootId}`,
                          retryPolicy: extractRetryPolicy,
                        },
                        () =>
                          wls(`identify:${rootId}`, () =>
                            withLangfuseObservation(
                              {
                                name: "repository-ingestion.identify",
                                input: { rootId, root },
                                metadata: {
                                  ...baseLangfuseMetadata,
                                  workflowStepName: `identify:${rootId}`,
                                  rootId,
                                  root,
                                },
                              },
                              () =>
                                withIngestAgentContext(
                                  {
                                    ...langfuseAttrs,
                                    runName: "repository-ingestion.identify",
                                    metadata: {
                                      workflowStepName: `identify:${rootId}`,
                                      rootId,
                                      root,
                                    },
                                  },
                                  () =>
                                    runIdentifyPhaseForRoot(
                                      baseIngestState,
                                      root,
                                      kindPartial,
                                    ),
                                ),
                            ),
                          ),
                      )
                    }),
                  )

                  const concatenatedObjects: ExtractedObject[] = []
                  const concatenatedClaims: ExtractedClaim[] = []
                  let extractionSkippedFiles = 0
                  for (const part of rootExtractResults) {
                    concatenatedObjects.push(...part.extractedObjects)
                    concatenatedClaims.push(...part.extractedClaims)
                    extractionSkippedFiles += part.extractionSkippedFiles ?? 0
                  }
                  const { extractedObjects, extractedClaims } =
                    await finalizeExtractedReferences({
                      orgId: baseIngestState.orgId,
                      extractedObjects: concatenatedObjects,
                      extractedClaims: concatenatedClaims,
                    })

                  const afterExtract: CodeIngestionState = {
                    ...baseIngestState,
                    roots,
                    extractedObjects,
                    extractedClaims,
                  }

                  const afterDedup = await runStep(
                    {
                      name: "deduplicateAndStore",
                      retryPolicy: extractRetryPolicy,
                    },
                    () =>
                      wls("deduplicateAndStore", () =>
                        deduplicateAndStore(afterExtract),
                      ),
                  )

                  const afterDedupState: CodeIngestionState = {
                    ...afterExtract,
                    ...afterDedup,
                    objectIds: afterDedup.objectIds ?? [],
                    touchedObjectIds: afterDedup.touchedObjectIds ?? [],
                    claimsForProjection: afterDedup.claimsForProjection ?? [],
                  }

                  await runStep(
                    { name: "project", retryPolicy: extractRetryPolicy },
                    () => wls("project", () => project(afterDedupState)),
                  )

                  await runStep(
                    { name: "embed", retryPolicy: extractRetryPolicy },
                    () =>
                      wls("embed", () =>
                        withLangfuseObservation(
                          {
                            name: "repository-ingestion.embed",
                            input: {
                              repositoryId: input.repositoryId,
                              targetHash: baseIngestState.targetHash,
                            },
                            metadata: {
                              ...baseLangfuseMetadata,
                              workflowStepName: "embed",
                              rootId: null,
                              root: null,
                            },
                          },
                          () => embed(afterDedupState),
                        ),
                      ),
                  )

                  return {
                    roots,
                    extractedObjects,
                    extractedClaims,
                    extractionSkippedFiles,
                    afterDedupState,
                  }
                },
              )

              const {
                roots,
                extractedObjects,
                extractedClaims,
                extractionSkippedFiles,
                afterDedupState,
              } = extractResult

              logWorkflowMilestone("repository-ingestion.extract.complete", {
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                targetHash: reindexState.targetHash ?? resolved.hash,
                rootsCount: roots.length,
                extractedObjectsCount: extractedObjects.length,
                extractedClaimsCount: extractedClaims.length,
                objectIdsCount: afterDedupState.objectIds?.length ?? 0,
                claimsForProjectionCount:
                  afterDedupState.claimsForProjection?.length ?? 0,
              })

              const result = {
                repositoryId: input.repositoryId,
                targetHash: reindexState.targetHash ?? resolved.hash,
                sourceBranch: resolved.branch,
              }

              // Full ingests re-observe everything still true at the target commit;
              // whatever this repository's extractors did not touch since the index
              // child finished (`indexedAt`: same worker clock, stamped before any
              // extraction, cached for runs already in flight) is stale. Skipped
              // when an index degraded, so a partial run never retracts.
              let graphEffects = retractionResult.retractionGraphEffects
              const observedBefore = reindexState.indexedAt
                ? new Date(reindexState.indexedAt)
                : null
              // An extractor that skipped files on LLM failure did not observe
              // everything; sweeping would retract those files' facts.
              const canSweepUnobserved =
                reindexState.ingestMode === "full" &&
                reindexState.searchIndexOk !== false &&
                reindexState.scipIndexOk !== false &&
                observedBefore !== null &&
                extractionSkippedFiles === 0
              if (canSweepUnobserved && observedBefore) {
                const sweep = await runStep(
                  { name: "retract-unobserved-evidence" },
                  () =>
                    wls("retract-unobserved-evidence", () =>
                      withOrgDbContext(input.orgId, (db) =>
                        retractUnobservedRepositoryEvidencePg(db, {
                          orgId: input.orgId,
                          repositoryId: input.repositoryId,
                          observedBefore,
                        }),
                      ),
                    ),
                )
                logWorkflowMilestone(
                  "repository-ingestion.step.unobserved-sweep.done",
                  {
                    repositoryId: input.repositoryId,
                    targetHash: result.targetHash,
                    observedBefore: observedBefore.toISOString(),
                    ...sweep.stats,
                  },
                )
                graphEffects = {
                  deletedClaimIds: [
                    ...graphEffects.deletedClaimIds,
                    ...sweep.graphEffects.deletedClaimIds,
                  ],
                  refreshedClaimIds: [
                    ...graphEffects.refreshedClaimIds,
                    ...sweep.graphEffects.refreshedClaimIds,
                  ],
                  deletedObjectIds: [
                    ...graphEffects.deletedObjectIds,
                    ...sweep.graphEffects.deletedObjectIds,
                  ],
                }
              } else if (reindexState.ingestMode === "full") {
                logWorkflowMilestone(
                  "repository-ingestion.step.unobserved-sweep.skipped",
                  {
                    repositoryId: input.repositoryId,
                    targetHash: result.targetHash,
                    reason:
                      extractionSkippedFiles > 0
                        ? "extraction skipped files"
                        : observedBefore
                          ? "index degraded"
                          : "no indexedAt",
                    extractionSkippedFiles,
                  },
                )
              }

              const effects = graphEffects
              if (
                effects.deletedClaimIds.length > 0 ||
                effects.refreshedClaimIds.length > 0 ||
                effects.deletedObjectIds.length > 0
              ) {
                // Falkor graph sync must not hold an org PG transaction (external I/O).
                await runStep({ name: "sync-retraction-graph" }, async () => {
                  return wls("sync-retraction-graph", async () => {
                    await withOrgDbContext(input.orgId, () =>
                      setRepositoryIndexingStep({
                        repositoryId: input.repositoryId,
                        key: "syncing_graph",
                      }),
                    )
                    const graph =
                      await applyIngestionRetractionGraphEffects(effects)
                    retractionResult.retractionStats.graphEdgesDeleted =
                      graph.graphEdgesDeleted
                    retractionResult.retractionStats.graphClaimsRefreshed =
                      graph.graphClaimsRefreshed
                    retractionResult.retractionStats.graphOrphanObjectsDeleted =
                      graph.graphOrphanObjectsDeleted
                  })
                })
              }

              logWorkflowMilestone(
                "repository-ingestion.step.mark-success.start",
                {
                  repositoryId: input.repositoryId,
                  targetHash: result.targetHash,
                },
              )

              await runStep({ name: "set-step-finalizing" }, () =>
                wls("set-step-finalizing", () =>
                  withOrgDbContext(input.orgId, () =>
                    setRepositoryIndexingStep({
                      repositoryId: input.repositoryId,
                      key: "finalizing",
                    }),
                  ),
                ),
              )

              await runStep({ name: "mark-success" }, () =>
                wls("mark-success", () =>
                  withOrgDbContext(input.orgId, () => {
                    const parts: string[] = []
                    if (reindexState.searchIndexOk === false) {
                      parts.push(
                        reindexState.searchIndexError?.trim() ||
                          "Search index unavailable",
                      )
                    }
                    if (reindexState.scipIndexOk === false) {
                      parts.push(
                        reindexState.scipIndexError?.trim() ||
                          "SCIP index unavailable",
                      )
                    }
                    const issueError = [...new Set(parts.filter(Boolean))].join(
                      "; ",
                    )
                    return issueError
                      ? markRepositoryIndexingReadyWithIssues({
                          repositoryId: input.repositoryId,
                          targetHash: result.targetHash,
                          error: issueError,
                        })
                      : markRepositoryIndexingReady({
                          repositoryId: input.repositoryId,
                          targetHash: result.targetHash,
                        })
                  }),
                ),
              )

              logWorkflowMilestone(
                "repository-ingestion.step.mark-success.done",
                {
                  repositoryId: input.repositoryId,
                  targetHash: result.targetHash,
                },
              )

              // Outside org tx: if tip moved while we were ingesting, start one
              // coalesced follow-up for this repository.
              const followUp = await runStep(
                {
                  name: "enqueue-follow-up-if-tip-ahead",
                  retryPolicy: {
                    maximumAttempts: 5,
                    initialInterval: "30s",
                    backoffCoefficient: 2,
                    maximumInterval: "5m",
                  },
                },
                () =>
                  wls("enqueue-follow-up-if-tip-ahead", () =>
                    enqueueFollowUpIfTipAhead(
                      {
                        orgId: input.orgId,
                        repositoryId: input.repositoryId,
                        ingestedHash: result.targetHash,
                        githubConnectionId,
                        targetBranch: input.targetBranch ?? result.sourceBranch,
                      },
                      {
                        error: (err) =>
                          getLogger().error(err, {
                            step: "repository-ingestion.follow-up-tip",
                            repositoryId: input.repositoryId,
                            orgId: input.orgId,
                          }),
                      },
                    ),
                  ),
              )

              logWorkflowMilestone("repository-ingestion.follow-up-tip.done", {
                repositoryId: input.repositoryId,
                ingestedHash: result.targetHash,
                tipHash: followUp.tipHash ?? null,
                enqueued: followUp.enqueued,
              })

              logWorkflowMilestone("repository-ingestion.complete", {
                repositoryId: input.repositoryId,
                targetHash: result.targetHash,
              })

              return result
            } catch (err: unknown) {
              if (!(err instanceof IngestionAborted)) throw err
              logWorkflowMilestone("repository-ingestion.stopped", {
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                reason: "repository_deleted",
              })
              return {
                aborted: "repository_deleted" as const,
                repositoryId: input.repositoryId,
              }
            }
          },
        )
      },
    ),
)
