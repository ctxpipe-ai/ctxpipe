import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { activateRepositoryIngestionRequest } from "../../models/repository-ingestion-requests.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { repositoryIngestion } from "./repository-ingestion.js"

const repositoryIngestionOrchestratorInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetBranch: z.string().nullable().optional(),
  indexingReason: z.string().nullable().optional(),
  requestId: z.string().min(1).optional(),
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
          },
          { name: "repository-ingestion-child" },
        )
      },
    ),
)
