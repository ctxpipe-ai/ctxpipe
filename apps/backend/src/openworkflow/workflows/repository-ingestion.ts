import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { resolveRepositoryRef } from "../../domain/codeIngestion/queue.js"
import { isRepositoryGoneError } from "../../domain/codeIngestion/repositoryGone.js"
import { captureRepositoryExtractionTarget } from "../../domain/workspaces/capture-repository-extraction.js"
import {
  extractionRetraction,
  extractionRootsSchema,
  partialRetractionPaths,
  workspaceExtractionSchema,
} from "../../domain/workspaces/extraction.js"
import { identifyRoots } from "../../graphs/codeIngestionGraph/nodes/identifyRoots.js"
import {
  EXTRACTOR_VERSION,
  runExtractKindForRoot,
  runIdentifyPhaseForRoot,
  stableRootStepId,
} from "../../graphs/codeIngestionGraph/runExtractRoot.js"
import type { CodeIngestionState } from "../../graphs/codeIngestionGraph/schemas.js"
import { withIngestAgentContext } from "../../graphs/codeIngestionGraph/withIngestAgentContext.js"
import {
  markRepositoryIndexingIssues,
  markRepositoryIndexingReady,
  markRepositoryIndexingReadyWithIssues,
  markRepositoryIndexingRunning,
  repositoryIngestionBlockedByDeletion,
  setRepositoryIndexingStep,
} from "../../models/repositories.js"
import {
  deleteExtractionCapture,
  deleteRepositoryExtractionCaptures,
  type ExtractionCaptureKey,
} from "../../models/repository-extraction-captures.js"
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
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { enqueueFollowUpIfTipAhead } from "../enqueue-follow-up-if-tip-ahead.js"
import { indexingOutcome } from "../indexing-outcome.js"
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
  /** Checkpointed with connector writes so replay cannot switch installations. */
  githubConnectionId: z.string().nullable().optional(),
  /** Ignore the last ingested commit: full codesearch mode plus the unobserved-evidence sweep. */
  fullReingest: z.boolean().optional(),
})

/** The extraction write job one repository-ingestion run publishes through. */
export function extractionWriteJobId(repositoryIngestionRunId: string): string {
  return `wjob_${repositoryIngestionRunId}_extract`
}

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
  async ({ input, step: rawStep, run }) =>
    withLogger(
      createLogger({
        workflow: "repository-ingestion",
        repositoryId: input.repositoryId,
        orgId: input.orgId,
      }),
      async () => {
        // Codesearch 404 becomes a sentinel. Throwing inside `step.run` makes
        // OpenWorkflow retry the step, so the stop is a return value.
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
              try {
                return await fn()
              } catch (err: unknown) {
                if (!isRepositoryGoneError(err)) throw err
                return REPOSITORY_INGESTION_STOPPED
              }
            },
          )

        const step = {
          run: async <T>(
            config: Parameters<typeof rawStep.run>[0],
            fn: () => Promise<T>,
          ): Promise<Exclude<T, typeof REPOSITORY_INGESTION_STOPPED>> => {
            const result = await rawStep.run(
              config,
              fn as Parameters<typeof rawStep.run>[1],
            )
            return continueIngestion(result as T)
          },
          runWorkflow: rawStep.runWorkflow.bind(rawStep),
        }

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

              const repository = await step.run(
                { name: "get-repository" },
                () =>
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
              const fromHash = input.fullReingest
                ? undefined
                : (repository.lastIngestedHash ?? undefined)
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
                fullReingest: input.fullReingest ?? false,
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

              if (
                await repositoryIngestionBlockedByDeletion({
                  orgId: input.orgId,
                  repositoryId: input.repositoryId,
                })
              ) {
                throw new IngestionAborted()
              }

              // Durable codesearch phases via child workflow (no org DB txn across HTTP).
              const reindexState = await rawStep.runWorkflow(
                repositoryIndex.spec,
                {
                  ...(requestId ? { requestId } : {}),
                  repositoryId: input.repositoryId,
                  orgId: input.orgId,
                  targetHash: resolved.hash,
                  ...(fromHash ? { fromHash } : {}),
                  ...(githubConnectionId ? { githubConnectionId } : {}),
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

              logWorkflowMilestone("repository-ingestion.step.ingest.start", {
                repositoryId: input.repositoryId,
                targetHash: reindexState.targetHash ?? resolved.hash,
              })

              const partialPaths =
                reindexState.ingestMode === "partial"
                  ? partialRetractionPaths(reindexState)
                  : null
              const baseIngestState: CodeIngestionState = {
                requestId,
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                githubConnectionId: githubConnectionId ?? undefined,
                fromHash,
                targetHash: reindexState.targetHash ?? resolved.hash,
                indexedAt: reindexState.indexedAt,
                ...(partialPaths
                  ? {
                      ingestMode: "partial",
                      changedPaths: reindexState.changedPaths,
                      deletedPaths: reindexState.deletedPaths,
                      renames: reindexState.renames,
                    }
                  : { ingestMode: "full" }),
                roots: [],
                extractedObjects: [],
                extractedClaims: [],
              }

              const captureKey: ExtractionCaptureKey = {
                orgId: input.orgId,
                repositoryId: input.repositoryId,
                sourceSha: baseIngestState.targetHash,
                // A partial capture holds only the changed paths since its base commit.
                scope:
                  baseIngestState.ingestMode === "partial"
                    ? `since:${baseIngestState.fromHash ?? ""}`
                    : "full",
                extractorVersion: EXTRACTOR_VERSION,
              }
              if (input.fullReingest)
                // A full re-index extracts each root again; it reuses no stored root.
                await step.run({ name: "discard-extraction-capture" }, () =>
                  deleteExtractionCapture(captureKey),
                )

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
                      {
                        name: "identify-roots",
                        retryPolicy: extractRetryPolicy,
                      },
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
                                  source: {
                                    orgId: input.orgId,
                                    repositoryId: input.repositoryId,
                                    sha: resolved.hash,
                                  },
                                  runName:
                                    "repository-ingestion.identify-roots",
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

                    let extractedObjectsCount = 0
                    let extractedClaimsCount = 0
                    let skippedFiles = 0
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
                                        source: {
                                          orgId: input.orgId,
                                          repositoryId: input.repositoryId,
                                          sha: resolved.hash,
                                        },
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
                                          captureKey,
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
                                        source: {
                                          orgId: input.orgId,
                                          repositoryId: input.repositoryId,
                                          sha: resolved.hash,
                                        },
                                        runName:
                                          "repository-ingestion.identify",
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
                                          captureKey,
                                        ),
                                    ),
                                ),
                              ),
                          )
                        }),
                      )

                      for (const counts of rootExtractResults) {
                        extractedObjectsCount += counts.objects
                        extractedClaimsCount += counts.claims
                        skippedFiles += counts.skippedFiles
                      }
                    }
                    return {
                      roots,
                      extractedObjectsCount,
                      extractedClaimsCount,
                      skippedFiles,
                    }
                  })
                : {
                    roots: [],
                    extractedObjectsCount: 0,
                    extractedClaimsCount: 0,
                    skippedFiles: 0,
                  }

              const {
                roots,
                extractedObjectsCount,
                extractedClaimsCount,
                skippedFiles,
              } = extractResult
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
                  sourceSha: captureKey.sourceSha,
                  sourceDeclaration: destination.sourceDeclaration,
                  retraction: extractionRetraction({
                    partialPaths,
                    observedAt:
                      reindexState.indexedAt ?? run.createdAt.toISOString(),
                    skippedFiles,
                  }),
                  capture: {
                    scope: captureKey.scope,
                    extractorVersion: captureKey.extractorVersion,
                    roots,
                  },
                })
                await step.runWorkflow(
                  workspaceExtractIngest.spec,
                  {
                    orgId: input.orgId,
                    workspaceId: destination.workspaceId,
                    revision: destination.revision,
                    jobId: extractionWriteJobId(run.id),
                    extraction,
                  },
                  { name: "publish-extracted-knowledge" },
                )
                await step.run({ name: "delete-extraction-capture" }, () =>
                  deleteRepositoryExtractionCaptures(captureKey, run.createdAt),
                )
              }

              logWorkflowMilestone("repository-ingestion.extract.complete", {
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                targetHash: reindexState.targetHash ?? resolved.hash,
                rootsCount: roots.length,
                extractedObjectsCount,
                extractedClaimsCount,
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
                  withOrgDbContext(input.orgId, () => {
                    const outcome = indexingOutcome(reindexState)
                    if (outcome.kind === "issues")
                      return markRepositoryIndexingIssues({
                        requestId,
                        repositoryId: input.repositoryId,
                        error: outcome.error,
                      })
                    return outcome.kind === "ready-with-issues"
                      ? markRepositoryIndexingReadyWithIssues({
                          requestId,
                          repositoryId: input.repositoryId,
                          targetHash: result.targetHash,
                          error: outcome.error,
                        })
                      : markRepositoryIndexingReady({
                          requestId,
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
                        targetBranch: input.targetBranch,
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
            } catch (err) {
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
