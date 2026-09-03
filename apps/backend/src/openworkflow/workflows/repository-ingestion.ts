import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { resolveRepositoryRef } from "../../domain/codeIngestion/queue.js"
import { deduplicateAndStore } from "../../graphs/codeIngestionGraph/nodes/deduplicateAndStore.js"
import { embed } from "../../graphs/codeIngestionGraph/nodes/embed.js"
import { identifyRoots } from "../../graphs/codeIngestionGraph/nodes/identifyRoots.js"
import { project } from "../../graphs/codeIngestionGraph/nodes/project.js"
import { retractStaleEvidence } from "../../graphs/codeIngestionGraph/nodes/retractStaleEvidence.js"
import {
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
  setRepositoryIndexingStep,
} from "../../models/repositories.js"
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
import { applyIngestionRetractionGraphEffects } from "../../retrieval/services/ingestionRetraction.js"
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
})

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
        const wls = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
          withLoggedStepAttempt(
            name,
            {
              workflow: "repository-ingestion",
              repositoryId: input.repositoryId,
              orgId: input.orgId,
            },
            fn,
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

        return await withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
          await step.run({ name: "mark-running" }, () =>
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

          const repository = await step.run({ name: "get-repository" }, () =>
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
          logWorkflowMilestone("repository-ingestion.repository-loaded", {
            repositoryId: input.repositoryId,
            lastIngestedHash: repository.lastIngestedHash,
            githubConnectionId,
          })

          await step.run({ name: "set-step-resolving-ref" }, () =>
            wls("set-step-resolving-ref", () =>
              withOrgDbContext(input.orgId, () =>
                setRepositoryIndexingStep({
                  repositoryId: input.repositoryId,
                  key: "resolving_ref",
                }),
              ),
            ),
          )

          logWorkflowMilestone("repository-ingestion.step.resolve-ref.start", {
            repositoryId: input.repositoryId,
            branch: input.targetBranch ?? null,
          })

          const resolved = await step.run({ name: "resolve-ref" }, () =>
            wls("resolve-ref", () =>
              resolveRepositoryRef({
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                branch: input.targetBranch ?? undefined,
                githubConnectionId,
              }),
            ),
          )

          logWorkflowMilestone("repository-ingestion.step.resolve-ref.done", {
            repositoryId: input.repositoryId,
            targetHash: resolved.hash,
            branch: resolved.branch,
          })

          logWorkflowMilestone("repository-ingestion.ref-resolved", {
            targetHash: resolved.hash,
            sourceBranch: resolved.branch,
          })

          logWorkflowMilestone("repository-ingestion.step.reindex.start", {
            repositoryId: input.repositoryId,
            targetHash: resolved.hash,
          })

          // Durable codesearch phases via child workflow (no org DB txn across HTTP).
          const reindexState = await step.runWorkflow(
            repositoryIndex.spec,
            {
              repositoryId: input.repositoryId,
              orgId: input.orgId,
              targetHash: resolved.hash,
              ...(repository.lastIngestedHash
                ? { fromHash: repository.lastIngestedHash }
                : {}),
              ...(githubConnectionId
                ? { githubConnectionId }
                : {}),
            },
            { name: "repository-index" },
          )

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

          logWorkflowMilestone("repository-ingestion.step.retraction.start", {
            repositoryId: input.repositoryId,
            targetHash: reindexState.targetHash ?? resolved.hash,
            ingestMode: reindexState.ingestMode,
          })

          await step.run({ name: "set-step-retracting" }, () =>
            wls("set-step-retracting", () =>
              withOrgDbContext(input.orgId, () =>
                setRepositoryIndexingStep({
                  repositoryId: input.repositoryId,
                  key: "retracting",
                }),
              ),
            ),
          )

          const retractionResult = await step.run(
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

          logWorkflowMilestone("repository-ingestion.step.retraction.done", {
            repositoryId: input.repositoryId,
            targetHash: reindexState.targetHash ?? resolved.hash,
            retractionStats: retractionResult.retractionStats,
          })

          logWorkflowMilestone("repository-ingestion.step.ingest.start", {
            repositoryId: input.repositoryId,
            targetHash: reindexState.targetHash ?? resolved.hash,
          })

          const baseIngestState: CodeIngestionState = {
            repositoryId: input.repositoryId,
            orgId: input.orgId,
            githubConnectionId: githubConnectionId ?? undefined,
            fromHash: repository.lastIngestedHash ?? undefined,
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
          const langfuseAttrs = {
            sessionId: ingestionRunId,
            tags: ["repository-ingestion"],
            traceMetadata: baseLangfuseMetadata,
          }

          const extractResult = await runWithLangfuseContext(
            langfuseAttrs,
            async () => {
              const rootsPartial = await step.run(
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
                  const kindPartial = await step.run(
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
                                runName: "repository-ingestion.extract-kind",
                                metadata: {
                                  workflowStepName: `extract-kind:${rootId}`,
                                  rootId,
                                  root,
                                },
                              },
                              () =>
                                runExtractKindForRoot(baseIngestState, root),
                            ),
                        ),
                      ),
                  )

                  // Coarsen identify_* into one durable step per root (kind
                  // boundary stays durable). Avoids WORKFLOW_STEP_LIMIT blowups
                  // on large monorepos while preserving extractKind-before-
                  // identify ordering and cross-root parallelism.
                  return step.run(
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

              const extractedObjects: ExtractedObject[] = []
              const extractedClaims: ExtractedClaim[] = []
              for (const part of rootExtractResults) {
                extractedObjects.push(...part.extractedObjects)
                extractedClaims.push(...part.extractedClaims)
              }

              const afterExtract: CodeIngestionState = {
                ...baseIngestState,
                roots,
                extractedObjects,
                extractedClaims,
              }

              const afterDedup = await step.run(
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

              await step.run(
                { name: "project", retryPolicy: extractRetryPolicy },
                () => wls("project", () => project(afterDedupState)),
              )

              await step.run(
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
                afterDedupState,
              }
            },
          )

          const {
            roots,
            extractedObjects,
            extractedClaims,
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

          const effects = retractionResult.retractionGraphEffects
          if (
            effects.deletedClaimIds.length > 0 ||
            effects.refreshedClaimIds.length > 0 ||
            effects.deletedObjectIds.length > 0
          ) {
            // Falkor graph sync must not hold an org PG transaction (external I/O).
            await step.run({ name: "sync-retraction-graph" }, async () => {
              await wls("sync-retraction-graph", async () => {
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

          logWorkflowMilestone("repository-ingestion.step.mark-success.start", {
            repositoryId: input.repositoryId,
            targetHash: result.targetHash,
          })

          await step.run({ name: "set-step-finalizing" }, () =>
            wls("set-step-finalizing", () =>
              withOrgDbContext(input.orgId, () =>
                setRepositoryIndexingStep({
                  repositoryId: input.repositoryId,
                  key: "finalizing",
                }),
              ),
            ),
          )

          await step.run({ name: "mark-success" }, () =>
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

          logWorkflowMilestone("repository-ingestion.step.mark-success.done", {
            repositoryId: input.repositoryId,
            targetHash: result.targetHash,
          })

          // Outside org tx: if tip moved while we were ingesting, start one
          // coalesced follow-up for this repository.
          const followUp = await step.run(
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
        })
      },
    ),
)
