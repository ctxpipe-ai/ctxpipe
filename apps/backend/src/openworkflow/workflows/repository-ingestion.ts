import { eq } from "drizzle-orm"
import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getOrgDb, getSystemDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { resolveRepositoryRef } from "../../domain/codeIngestion/queue.js"
import { graph as codeIngestionGraph } from "../../graphs/codeIngestionGraph/graph.js"
import type { CodeIngestionState } from "../../graphs/codeIngestionGraph/schemas.js"
import {
  getLangfuseHandler,
  runWithLangfuseContext,
} from "../../observability/langfuse.js"
import { applyIngestionRetractionGraphEffects } from "../../retrieval/services/ingestionRetraction.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"

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

        const log = getLogger()
        log.set({
          step: "repository-ingestion.start",
          repositoryId: input.repositoryId,
          orgId: input.orgId,
        })
        log.info("repository-ingestion workflow started")
        flushWorkflowLog()

        const org = await getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        })

        if (!org) {
          throw new Error(`Organization not found: ${input.orgId}`)
        }

        return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
          let ingestOutputState: CodeIngestionState | undefined

          const result = await withOrgDbContext(input.orgId, async () => {
            const db = getOrgDb()

            logWorkflowMilestone(
              "repository-ingestion.step.get-repository.start",
              {
                repositoryId: input.repositoryId,
                orgId: input.orgId,
              },
            )

            const repository = await step.run({ name: "get-repository" }, () =>
              db.query.repositories.findFirst({
                where: {
                  id: { eq: input.repositoryId },
                  orgId: { eq: input.orgId },
                },
              }),
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
            log.set({
              step: "repository-ingestion.repository-loaded",
              repositoryId: input.repositoryId,
              lastIngestedHash: repository.lastIngestedHash,
              githubConnectionId,
            })
            log.info("repository row loaded")
            flushWorkflowLog()

            logWorkflowMilestone(
              "repository-ingestion.step.resolve-ref.start",
              {
                repositoryId: input.repositoryId,
                branch: input.targetBranch ?? null,
              },
            )

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

            log.set({
              step: "repository-ingestion.ref-resolved",
              targetHash: resolved.hash,
              sourceBranch: resolved.branch,
            })
            log.info("repository ref resolved for ingestion")
            flushWorkflowLog()

            logWorkflowMilestone("repository-ingestion.step.ingest.start", {
              repositoryId: input.repositoryId,
              targetHash: resolved.hash,
            })

            ingestOutputState = await step.run({ name: "ingest" }, () =>
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
                      targetHash: resolved.hash,
                    },
                  )

                  const result = await codeIngestionGraph.invoke(
                    {
                      repositoryId: input.repositoryId,
                      orgId: input.orgId,
                      githubConnectionId: githubConnectionId ?? undefined,
                      fromHash: repository.lastIngestedHash ?? undefined,
                      targetHash: resolved.hash,
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
                      targetHash: resolved.hash,
                    },
                  )

                  const logIngest = getLogger()
                  const state = result as CodeIngestionState
                  logIngest.set({
                    step: "repository-ingestion.graph.complete",
                    repositoryId: input.repositoryId,
                    orgId: input.orgId,
                    targetHash: resolved.hash,
                    indexedAt: state.indexedAt,
                    rootsCount: state.roots?.length ?? 0,
                    roots: state.roots,
                    extractedObjectsCount: state.extractedObjects?.length ?? 0,
                    extractedClaimsCount: state.extractedClaims?.length ?? 0,
                    objectIdsCount: state.objectIds?.length ?? 0,
                    claimsForProjectionCount:
                      state.claimsForProjection?.length ?? 0,
                  })
                  logIngest.info("repository ingestion graph completed")
                  flushWorkflowLog()
                  return result
                },
              ),
            )

            return {
              repositoryId: input.repositoryId,
              targetHash: resolved.hash,
              sourceBranch: resolved.branch,
            }
          })

          const effects = ingestOutputState?.retractionGraphEffects
          if (
            effects &&
            (effects.deletedClaimIds.length > 0 ||
              effects.refreshedClaimIds.length > 0 ||
              effects.deletedObjectIds.length > 0)
          ) {
            await step.run({ name: "sync-retraction-graph" }, () =>
              withOrgDbContext(input.orgId, async () => {
                const graph =
                  await applyIngestionRetractionGraphEffects(effects)
                if (ingestOutputState?.retractionStats) {
                  ingestOutputState.retractionStats.graphEdgesDeleted =
                    graph.graphEdgesDeleted
                  ingestOutputState.retractionStats.graphClaimsRefreshed =
                    graph.graphClaimsRefreshed
                  ingestOutputState.retractionStats.graphOrphanObjectsDeleted =
                    graph.graphOrphanObjectsDeleted
                }
              }),
            )
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

          const logDone = getLogger()
          logDone.set({
            step: "repository-ingestion.complete",
            repositoryId: input.repositoryId,
            targetHash: result.targetHash,
          })
          logDone.info("repository-ingestion workflow finished")
          flushWorkflowLog()

          return result
        })
      },
    ),
)
