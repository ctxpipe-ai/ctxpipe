import { eq } from "drizzle-orm"
import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  getOrgDb,
  getSystemDb,
  withOrgDbContext,
  withOrgDbHandleContext,
} from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { resolveRepositoryRef } from "../../domain/codeIngestion/queue.js"
import { extractionGraph } from "../../graphs/codeIngestionGraph/graph.js"
import {
  type CodeIngestionReindexInput,
  reindex as reindexRepository,
} from "../../graphs/codeIngestionGraph/nodes/reindex.js"
import {
  type CodeIngestionRetractInput,
  retractStaleEvidence,
} from "../../graphs/codeIngestionGraph/nodes/retractStaleEvidence.js"
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

        return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
          let ingestOutputState: CodeIngestionState | undefined

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

          const reindexInput: CodeIngestionReindexInput = {
            repositoryId: input.repositoryId,
            orgId: input.orgId,
            githubConnectionId: githubConnectionId ?? undefined,
            fromHash: repository.lastIngestedHash ?? undefined,
            targetHash: resolved.hash,
            sourceBranch: resolved.branch,
          }

          logWorkflowMilestone("repository-ingestion.step.reindex.start", {
            repositoryId: input.repositoryId,
            targetHash: resolved.hash,
          })

          const reindexState = await step.run({ name: "reindex" }, () =>
            reindexRepository(reindexInput),
          )

          logWorkflowMilestone("repository-ingestion.step.reindex.done", {
            repositoryId: input.repositoryId,
            targetHash: reindexState.targetHash ?? resolved.hash,
            ingestMode: reindexState.ingestMode ?? "full",
            changedPathsCount: reindexState.changedPaths?.length ?? 0,
            deletedPathsCount: reindexState.deletedPaths?.length ?? 0,
            renamesCount: reindexState.renames?.length ?? 0,
          })

          const retractionInput: CodeIngestionRetractInput = {
            repositoryId: input.repositoryId,
            orgId: input.orgId,
            ingestMode: reindexState.ingestMode,
            changedPaths: reindexState.changedPaths,
            deletedPaths: reindexState.deletedPaths,
            renames: reindexState.renames,
            targetHash: reindexState.targetHash ?? reindexInput.targetHash,
          }

          logWorkflowMilestone("repository-ingestion.step.retract-pg.start", {
            repositoryId: input.repositoryId,
            targetHash: retractionInput.targetHash,
          })

          const retractionState = await step.run({ name: "retract-pg" }, () =>
            withOrgDbContext(input.orgId, () =>
              retractStaleEvidence(retractionInput),
            ),
          )

          logWorkflowMilestone("repository-ingestion.step.retract-pg.done", {
            repositoryId: input.repositoryId,
            targetHash: retractionInput.targetHash,
            retractionStats: retractionState.retractionStats,
          })

          const extractionInput: CodeIngestionState = {
            ...reindexInput,
            ...reindexState,
            ...retractionState,
            targetHash: retractionInput.targetHash,
            extractedObjects: [],
            extractedClaims: [],
            objectIds: [],
            touchedObjectIds: [],
            claimsForProjection: [],
          }

          logWorkflowMilestone(
            "repository-ingestion.step.extract-and-store.start",
            {
              repositoryId: input.repositoryId,
              targetHash: extractionInput.targetHash,
            },
          )

          ingestOutputState = await step.run(
            { name: "extract-and-store" },
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
                    "repository-ingestion.extract-and-store.invoke-graph.start",
                    {
                      repositoryId: input.repositoryId,
                      targetHash: extractionInput.targetHash,
                    },
                  )

                  const graphResult = await withOrgDbHandleContext(() =>
                    extractionGraph.invoke(extractionInput, {
                      recursionLimit: 1000,
                      callbacks: [getLangfuseHandler()],
                    }),
                  )

                  logWorkflowMilestone(
                    "repository-ingestion.extract-and-store.invoke-graph.done",
                    {
                      repositoryId: input.repositoryId,
                      targetHash: extractionInput.targetHash,
                    },
                  )

                  const state = graphResult as CodeIngestionState
                  logWorkflowMilestone("repository-ingestion.graph.complete", {
                    repositoryId: input.repositoryId,
                    orgId: input.orgId,
                    targetHash: extractionInput.targetHash,
                    indexedAt: extractionInput.indexedAt,
                    rootsCount: state.roots?.length ?? 0,
                    roots: state.roots,
                    extractedObjectsCount: state.extractedObjects?.length ?? 0,
                    extractedClaimsCount: state.extractedClaims?.length ?? 0,
                    objectIdsCount: state.objectIds?.length ?? 0,
                    claimsForProjectionCount:
                      state.claimsForProjection?.length ?? 0,
                  })
                  return {
                    ...extractionInput,
                    ...state,
                    targetHash: extractionInput.targetHash,
                  } as CodeIngestionState
                },
              ),
          )

          const result = {
            repositoryId: input.repositoryId,
            targetHash: retractionInput.targetHash,
            sourceBranch: resolved.branch,
          }

          const effects = ingestOutputState?.retractionGraphEffects
          if (
            effects &&
            (effects.deletedClaimIds.length > 0 ||
              effects.refreshedClaimIds.length > 0 ||
              effects.deletedObjectIds.length > 0)
          ) {
            await step.run({ name: "sync-retraction-graph" }, async () => {
              const graph = await applyIngestionRetractionGraphEffects(effects)
              if (ingestOutputState?.retractionStats) {
                ingestOutputState.retractionStats.graphEdgesDeleted =
                  graph.graphEdgesDeleted
                ingestOutputState.retractionStats.graphClaimsRefreshed =
                  graph.graphClaimsRefreshed
                ingestOutputState.retractionStats.graphOrphanObjectsDeleted =
                  graph.graphOrphanObjectsDeleted
              }
            })
          }

          logWorkflowMilestone("repository-ingestion.step.mark-success.start", {
            repositoryId: input.repositoryId,
            targetHash: result.targetHash,
          })

          await step.run({ name: "mark-success" }, () =>
            withOrgDbContext(input.orgId, async () => {
              const db = getOrgDb()
              return db
                .update(repositories)
                .set({
                  indexReady: true,
                  indexingReason: null,
                  lastIngestedHash: result.targetHash,
                  updatedAt: new Date(),
                })
                .where(eq(repositories.id, input.repositoryId))
            }),
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
      },
    ),
)
