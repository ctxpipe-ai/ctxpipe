import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { resolveRepositoryRef } from "../../domain/codeIngestion/queue.js"
import { captureRepositoryExtractionTarget } from "../../domain/workspaces/capture-repository-extraction.js"
import {
  captureExtractionClaimSourcePath,
  extractionCaptureBudgetSchema,
  extractionRootsSchema,
  workspaceExtractionSchema,
} from "../../domain/workspaces/extraction.js"
import { identifyRoots } from "../../graphs/codeIngestionGraph/nodes/identifyRoots.js"
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
  assertRepositoryIngestionRequest,
  captureRepositoryIngestionRequest,
} from "../../models/repository-ingestion-requests.js"
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
import { enqueueFollowUpIfTipAhead } from "../enqueue-follow-up-if-tip-ahead.js"
import { withLoggedStepAttempt } from "../withLoggedStepAttempt.js"
import { repositoryIndex } from "./repository-index.js"
import { workspaceExtractIngest } from "./workspace-extract-ingest.js"

const repositoryIngestionInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetBranch: z.string().nullable().optional(),
  /** Stored on the row while ingestion runs; cleared on success. */
  indexingReason: z.string().nullable().optional(),
  requestId: z.string().min(1).optional(),
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

        return await withOrgIdContext(
          { id: org.id, slug: org.slug },
          async () => {
            const requestId =
              (await captureRepositoryIngestionRequest(input, run.id)) ??
              undefined
            await step.run({ name: "mark-running" }, () =>
              wls("mark-running", () =>
                withOrgDbContext(input.orgId, () =>
                  markRepositoryIndexingRunning({
                    requestId,
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

            const githubConnectionId = repository.githubConnectionId
            const destination = await step.run(
              { name: "capture-extraction-destination" },
              () =>
                captureRepositoryExtractionTarget({
                  orgId: input.orgId,
                  repositoryUrl: repository.gitUrl,
                  env: parseEnv(process.env),
                }),
            )
            logWorkflowMilestone("repository-ingestion.repository-loaded", {
              repositoryId: input.repositoryId,
              lastIngestedHash: repository.lastIngestedHash,
              githubConnectionId,
            })

            await step.run({ name: "set-step-resolving-ref" }, () =>
              wls("set-step-resolving-ref", () =>
                withOrgDbContext(input.orgId, () =>
                  setRepositoryIndexingStep({
                    requestId,
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

            const resolved = await step.run(
              {
                name: "resolve-ref",
                retryPolicy: { maximumAttempts: 1 },
              },
              () =>
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
                ...(githubConnectionId ? { githubConnectionId } : {}),
              },
              { name: "repository-index" },
            )

            logWorkflowMilestone("repository-ingestion.step.reindex.done", {
              repositoryId: input.repositoryId,
              targetHash: reindexState.targetHash ?? resolved.hash,
              ingestMode: reindexState.ingestMode,
              searchIndexOk: reindexState.searchIndexOk !== false,
              changedPathsCount: reindexState.changedPaths?.length ?? 0,
              deletedPathsCount: reindexState.deletedPaths?.length ?? 0,
              renamesCount: reindexState.renames?.length ?? 0,
            })

            logWorkflowMilestone("repository-ingestion.step.ingest.start", {
              repositoryId: input.repositoryId,
              targetHash: reindexState.targetHash ?? resolved.hash,
            })

            const baseIngestState: CodeIngestionState = {
              requestId,
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

            const extractResult = destination
              ? await runWithLangfuseContext(langfuseAttrs, async () => {
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

                  const roots = extractionRootsSchema.parse(
                    rootsPartial.roots ?? [],
                  )
                  logWorkflowMilestone(
                    "repository-ingestion.step.identify-roots.done",
                    {
                      repositoryId: input.repositoryId,
                      rootsCount: roots.length,
                      roots,
                    },
                  )

                  const extractedObjects: ExtractedObject[] = []
                  const extractedClaims: ExtractedClaim[] = []
                  // Two roots at a time bound provider fan-out before the next batch is allocated.
                  for (let offset = 0; offset < roots.length; offset += 2) {
                    const rootExtractResults = await Promise.all(
                      roots.slice(offset, offset + 2).map(async (root) => {
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

                    for (const part of rootExtractResults) {
                      extractedObjects.push(...part.extractedObjects)
                      extractedClaims.push(...part.extractedClaims)
                    }
                    extractionCaptureBudgetSchema.parse({
                      objects: extractedObjects,
                      claims: extractedClaims,
                    })
                  }

                  return { roots, extractedObjects, extractedClaims }
                })
              : { roots: [], extractedObjects: [], extractedClaims: [] }

            const { roots, extractedObjects, extractedClaims } = extractResult
            if (destination) {
              await assertRepositoryIngestionRequest({
                ...input,
                requestId,
                repositoryUrl: repository.gitUrl,
                githubConnectionId: repository.githubConnectionId,
              })
              const extraction = workspaceExtractionSchema.parse({
                ingestionRequestId: requestId,
                repositoryId: input.repositoryId,
                repositoryUrl: repository.gitUrl,
                sourceSha: reindexState.targetHash ?? resolved.hash,
                sourceDeclaration: destination.sourceDeclaration,
                retraction:
                  reindexState.ingestMode === "partial"
                    ? {
                        mode: "partial",
                        observedAt:
                          reindexState.indexedAt ?? run.createdAt.toISOString(),
                        paths: [
                          ...new Set([
                            ...(reindexState.changedPaths ?? []),
                            ...(reindexState.deletedPaths ?? []),
                            ...(reindexState.renames ?? []).flatMap(
                              (rename) => [rename.from, rename.to],
                            ),
                          ]),
                        ],
                      }
                    : {
                        mode: "full",
                        observedAt:
                          reindexState.indexedAt ?? run.createdAt.toISOString(),
                      },
                objects: extractedObjects,
                claims: extractedClaims.map((claim) => ({
                  subjectRef: claim.subjectRef,
                  objectRef: claim.objectRef,
                  predicate: claim.predicate,
                  confidence: claim.confidence,
                  sourceId: claim.sourceId,
                  sourcePath: captureExtractionClaimSourcePath(
                    claim.provenance,
                  ),
                })),
              })
              await step.runWorkflow(
                workspaceExtractIngest.spec,
                {
                  orgId: input.orgId,
                  workspaceId: destination.workspaceId,
                  revision: destination.revision,
                  jobId: `wjob_${run.id}_extract`,
                  extraction,
                },
                { name: "publish-extracted-knowledge" },
              )
            }

            logWorkflowMilestone("repository-ingestion.extract.complete", {
              repositoryId: input.repositoryId,
              orgId: input.orgId,
              targetHash: reindexState.targetHash ?? resolved.hash,
              rootsCount: roots.length,
              extractedObjectsCount: extractedObjects.length,
              extractedClaimsCount: extractedClaims.length,
            })

            const result = {
              repositoryId: input.repositoryId,
              targetHash: reindexState.targetHash ?? resolved.hash,
              sourceBranch: resolved.branch,
            }

            logWorkflowMilestone(
              "repository-ingestion.step.mark-success.start",
              {
                repositoryId: input.repositoryId,
                targetHash: result.targetHash,
              },
            )

            await step.run({ name: "set-step-finalizing" }, () =>
              wls("set-step-finalizing", () =>
                withOrgDbContext(input.orgId, () =>
                  setRepositoryIndexingStep({
                    requestId,
                    repositoryId: input.repositoryId,
                    key: "finalizing",
                  }),
                ),
              ),
            )

            await step.run({ name: "mark-success" }, () =>
              wls("mark-success", () =>
                withOrgDbContext(input.orgId, () =>
                  reindexState.searchIndexOk === false
                    ? markRepositoryIndexingReadyWithIssues({
                        requestId,
                        repositoryId: input.repositoryId,
                        targetHash: result.targetHash,
                        error:
                          reindexState.searchIndexError ??
                          "Search index unavailable",
                      })
                    : markRepositoryIndexingReady({
                        requestId,
                        repositoryId: input.repositoryId,
                        targetHash: result.targetHash,
                      }),
                ),
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
            // follow-up for this repo only (no auto-chain on failure paths).
            const followUp = await step.run(
              { name: "enqueue-follow-up-if-tip-ahead" },
              () =>
                wls("enqueue-follow-up-if-tip-ahead", () =>
                  enqueueFollowUpIfTipAhead(
                    {
                      orgId: input.orgId,
                      repositoryId: input.repositoryId,
                      ingestedHash: result.targetHash,
                      requestId: requestId ?? `legacy:${run.id}`,
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
          },
        )
      },
    ),
)
