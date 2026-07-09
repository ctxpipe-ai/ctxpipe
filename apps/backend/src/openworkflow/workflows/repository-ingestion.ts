import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { resolveRepositoryRef } from "../../domain/codeIngestion/queue.js"
import { graph as codeIngestionGraph } from "../../graphs/codeIngestionGraph/graph.js"
import { reindex } from "../../graphs/codeIngestionGraph/nodes/reindex.js"
import { retractStaleEvidence } from "../../graphs/codeIngestionGraph/nodes/retractStaleEvidence.js"
import {
  markRepositoryIndexingFailed,
  markRepositoryIndexingReady,
  markRepositoryIndexingRunning,
} from "../../models/repositories.js"
import type { CodeIngestionState } from "../../graphs/codeIngestionGraph/schemas.js"
import {
  getLangfuseHandler,
  runWithLangfuseContext,
} from "../../observability/langfuse.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { applyIngestionRetractionGraphEffects } from "../../retrieval/services/ingestionRetraction.js"

const repositoryIngestionInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetBranch: z.string().nullable().optional(),
  /** Stored on the row while ingestion runs; cleared on success. */
  indexingReason: z.string().nullable().optional(),
})

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
  async ({ input, step }) =>
    withLogger(
      createLogger({
        workflow: "repository-ingestion",
        repositoryId: input.repositoryId,
        orgId: input.orgId,
      }),
      async () => {
        try {
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
              withOrgDbContext(input.orgId, () =>
                markRepositoryIndexingRunning({
                  repositoryId: input.repositoryId,
                }),
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
            withOrgDbContext(input.orgId, (db) =>
              db.query.repositories.findFirst({
                where: {
                  id: { eq: input.repositoryId },
                  orgId: { eq: input.orgId },
                },
              }),
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
          logWorkflowMilestone("repository-ingestion.repository-loaded", {
            repositoryId: input.repositoryId,
            lastIngestedHash: repository.lastIngestedHash,
            githubConnectionId,
          })

          logWorkflowMilestone("repository-ingestion.step.resolve-ref.start", {
            repositoryId: input.repositoryId,
            branch: input.targetBranch ?? null,
          })

          const resolved = await step.run({ name: "resolve-ref" }, () =>
            resolveRepositoryRef({
              repositoryId: input.repositoryId,
              orgId: input.orgId,
              branch: input.targetBranch ?? undefined,
              githubConnectionId,
            }),
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

          const reindexState = await step.run({ name: "reindexStep" }, () =>
            withOrgDbContext(input.orgId, () =>
              reindex({
                repositoryId: input.repositoryId,
                orgId: input.orgId,
                githubConnectionId: githubConnectionId ?? undefined,
                fromHash: repository.lastIngestedHash ?? undefined,
                targetHash: resolved.hash,
              }),
            ),
          )

          logWorkflowMilestone("repository-ingestion.step.reindex.done", {
            repositoryId: input.repositoryId,
            targetHash: reindexState.targetHash ?? resolved.hash,
            ingestMode: reindexState.ingestMode,
            changedPathsCount: reindexState.changedPaths?.length ?? 0,
            deletedPathsCount: reindexState.deletedPaths?.length ?? 0,
            renamesCount: reindexState.renames?.length ?? 0,
          })

          logWorkflowMilestone("repository-ingestion.step.retraction.start", {
            repositoryId: input.repositoryId,
            targetHash: reindexState.targetHash ?? resolved.hash,
            ingestMode: reindexState.ingestMode,
          })

          const retractionResult = await step.run(
            { name: "retractionStep" },
            () =>
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

          await step.run(
            { name: "ingest", retryPolicy: { maximumAttempts: 2 } },
            () =>
              runWithLangfuseContext(
                {
                  sessionId: input.repositoryId,
                  tags: ["repository-ingestion"],
                  traceMetadata: {
                    workflow: "repository-ingestion",
                    repositoryId: input.repositoryId,
                    orgId: input.orgId,
                  },
                },
                async () => {
                  logWorkflowMilestone(
                    "repository-ingestion.ingest.invoke-graph.start",
                    {
                      repositoryId: input.repositoryId,
                      targetHash: reindexState.targetHash ?? resolved.hash,
                    },
                  )

                  const graphResult = await codeIngestionGraph.invoke(
                    {
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
                    },
                    {
                      recursionLimit: 1000,
                      callbacks: [getLangfuseHandler()],
                    },
                  )

                  logWorkflowMilestone(
                    "repository-ingestion.ingest.invoke-graph.done",
                    {
                      repositoryId: input.repositoryId,
                      targetHash: reindexState.targetHash ?? resolved.hash,
                    },
                  )

                  const state = graphResult as CodeIngestionState
                  logWorkflowMilestone("repository-ingestion.graph.complete", {
                    repositoryId: input.repositoryId,
                    orgId: input.orgId,
                    targetHash: reindexState.targetHash ?? resolved.hash,
                    indexedAt: state.indexedAt,
                    rootsCount: state.roots?.length ?? 0,
                    roots: state.roots,
                    extractedObjectsCount: state.extractedObjects?.length ?? 0,
                    extractedClaimsCount: state.extractedClaims?.length ?? 0,
                    objectIdsCount: state.objectIds?.length ?? 0,
                    claimsForProjectionCount:
                      state.claimsForProjection?.length ?? 0,
                  })
                  return graphResult as CodeIngestionState
                },
              ),
          )

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
            await step.run({ name: "sync-retraction-graph" }, () =>
              withOrgDbContext(input.orgId, async () => {
                const graph =
                  await applyIngestionRetractionGraphEffects(effects)
                retractionResult.retractionStats.graphEdgesDeleted =
                  graph.graphEdgesDeleted
                retractionResult.retractionStats.graphClaimsRefreshed =
                  graph.graphClaimsRefreshed
                retractionResult.retractionStats.graphOrphanObjectsDeleted =
                  graph.graphOrphanObjectsDeleted
              }),
            )
          }

          logWorkflowMilestone("repository-ingestion.step.mark-success.start", {
            repositoryId: input.repositoryId,
            targetHash: result.targetHash,
          })

          await step.run({ name: "mark-success" }, () =>
            withOrgDbContext(input.orgId, () =>
              markRepositoryIndexingReady({
                repositoryId: input.repositoryId,
                targetHash: result.targetHash,
              }),
            ),
          )

          logWorkflowMilestone("repository-ingestion.step.mark-success.done", {
            repositoryId: input.repositoryId,
            targetHash: result.targetHash,
          })

          logWorkflowMilestone("repository-ingestion.complete", {
            repositoryId: input.repositoryId,
            targetHash: result.targetHash,
          })

            return result
          })
        } catch (err: unknown) {
          const normalized = err instanceof Error ? err : new Error(String(err))

          logWorkflowMilestone("repository-ingestion.failed", {
            repositoryId: input.repositoryId,
            orgId: input.orgId,
            error: normalized.message,
          })

          await withOrgDbContext(input.orgId, () =>
            markRepositoryIndexingFailed({
              repositoryId: input.repositoryId,
              error: normalized,
            }),
          ).catch((markErr: unknown) => {
            getLogger().error(
              markErr instanceof Error ? markErr : new Error(String(markErr)),
              {
                step: "repository-ingestion.mark-failed",
                repositoryId: input.repositoryId,
                orgId: input.orgId,
              },
            )
          })

          throw normalized
        }
      },
    ),
)
