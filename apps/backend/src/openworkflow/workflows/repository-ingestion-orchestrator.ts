import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import {
  markRepositoryIndexingFailed,
  repositoryIngestionBlockedByDeletion,
} from "../../models/repositories.js"
import { activateRepositoryIngestionRequest } from "../../models/repository-ingestion-requests.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { isWorkflowControlSignal } from "../isSleepSignal.js"
import { repositoryIngestion } from "./repository-ingestion.js"

const repositoryIngestionOrchestratorInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetBranch: z.string().nullable().optional(),
  indexingReason: z.string().nullable().optional(),
  requestId: z.string().min(1).optional(),
  githubConnectionId: z.string().nullable().optional(),
  fullReingest: z.boolean().optional(),
})

export const repositoryIngestionOrchestrator = defineWorkflow(
  {
    name: "repository-ingestion-orchestrator",
    schema: repositoryIngestionOrchestratorInputSchema,
  },
  async ({ input, step, run }) =>
    withLogger(
      createLogger({
        workflow: "repository-ingestion-orchestrator",
        repositoryId: input.repositoryId,
        orgId: input.orgId,
      }),
      async () => {
        const requestId = await step.run(
          { name: "activate-ingestion-request" },
          () => activateRepositoryIngestionRequest(input, run.id),
        )
        try {
          return await step.runWorkflow(
            repositoryIngestion.spec,
            {
              repositoryId: input.repositoryId,
              orgId: input.orgId,
              requestId,
              ...(input.targetBranch !== undefined
                ? { targetBranch: input.targetBranch }
                : {}),
              ...(input.indexingReason !== undefined
                ? { indexingReason: input.indexingReason }
                : {}),
              ...(input.githubConnectionId !== undefined
                ? { githubConnectionId: input.githubConnectionId }
                : {}),
              ...(input.fullReingest !== undefined
                ? { fullReingest: input.fullReingest }
                : {}),
            },
            { name: "repository-ingestion-child" },
          )
        } catch (err: unknown) {
          if (isWorkflowControlSignal(err)) {
            throw err
          }

          const normalized = err instanceof Error ? err : new Error(String(err))
          const deleted = await repositoryIngestionBlockedByDeletion({
            orgId: input.orgId,
            repositoryId: input.repositoryId,
          })
          if (deleted) {
            getLogger().info("repository-ingestion-orchestrator.stopped", {
              step: "repository-ingestion-orchestrator.stopped",
              workflow: "repository-ingestion-orchestrator",
              repositoryId: input.repositoryId,
              orgId: input.orgId,
              reason: "repository_deleted",
            })
            flushWorkflowLog()
            return {
              aborted: "repository_deleted" as const,
              repositoryId: input.repositoryId,
            }
          }

          getLogger().error(normalized, {
            step: "repository-ingestion-orchestrator.child-failed",
            workflow: "repository-ingestion-orchestrator",
            repositoryId: input.repositoryId,
            orgId: input.orgId,
            errMessage: normalized.message,
            errName: normalized.name,
          })
          flushWorkflowLog()

          await step.run(
            {
              name: "mark-failed",
              retryPolicy: {
                maximumAttempts: 5,
                initialInterval: "30s",
                backoffCoefficient: 2,
                maximumInterval: "5m",
              },
            },
            () =>
              withOrgDbContext(input.orgId, () =>
                markRepositoryIndexingFailed({
                  repositoryId: input.repositoryId,
                  error: normalized,
                }),
              ),
          )

          throw normalized
        }
      },
    ),
)
