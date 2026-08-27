import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { markRepositoryIndexingFailed } from "../../models/repositories.js"
import {
  createLogger,
  flushWorkflowLog,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { enqueueFollowUpIfTipAhead } from "../enqueue-follow-up-if-tip-ahead.js"
import { repositoryIngestion } from "./repository-ingestion.js"

const repositoryIngestionOrchestratorInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetBranch: z.string().nullable().optional(),
  indexingReason: z.string().nullable().optional(),
  githubConnectionId: z.string().nullable().optional(),
})

function isSleepSignal(err: unknown): boolean {
  return err instanceof Error && err.name === "SleepSignal"
}

export const repositoryIngestionOrchestrator = defineWorkflow(
  {
    name: "repository-ingestion-orchestrator",
    schema: repositoryIngestionOrchestratorInputSchema,
  },
  async ({ input, step }) =>
    withLogger(
      createLogger({
        workflow: "repository-ingestion-orchestrator",
        repositoryId: input.repositoryId,
        orgId: input.orgId,
      }),
      async () => {
        try {
          return await step.runWorkflow(
            repositoryIngestion.spec,
            {
              repositoryId: input.repositoryId,
              orgId: input.orgId,
              ...(input.targetBranch !== undefined
                ? { targetBranch: input.targetBranch }
                : {}),
              ...(input.indexingReason !== undefined
                ? { indexingReason: input.indexingReason }
                : {}),
              ...(input.githubConnectionId !== undefined
                ? { githubConnectionId: input.githubConnectionId }
                : {}),
            },
            { name: "repository-ingestion-child" },
          )
        } catch (err: unknown) {
          if (isSleepSignal(err)) {
            throw err
          }

          const normalized = err instanceof Error ? err : new Error(String(err))

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

          await step.run(
            {
              name: "enqueue-pending-follow-up",
              retryPolicy: {
                maximumAttempts: 5,
                initialInterval: "30s",
                backoffCoefficient: 2,
                maximumInterval: "5m",
              },
            },
            () =>
              enqueueFollowUpIfTipAhead(
                {
                  orgId: input.orgId,
                  repositoryId: input.repositoryId,
                  pendingOnly: true,
                  targetBranch: input.targetBranch,
                  githubConnectionId: input.githubConnectionId,
                },
                {
                  error: (followUpError) =>
                    getLogger().error(followUpError, {
                      step: "repository-ingestion-orchestrator.follow-up",
                      repositoryId: input.repositoryId,
                      orgId: input.orgId,
                    }),
                },
              ),
          )

          throw normalized
        }
      },
    ),
)
