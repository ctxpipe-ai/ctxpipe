import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { markRepositoryIndexingFailed } from "../../models/repositories.js"
import { createLogger, getLogger, withLogger } from "../../observability/logger.js"
import { repositoryIngestion } from "./repository-ingestion.js"

const repositoryIngestionOrchestratorInputSchema = z.object({
  repositoryId: z.string().min(1),
  orgId: z.string().min(1),
  targetBranch: z.string().nullable().optional(),
  indexingReason: z.string().nullable().optional(),
})

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
            },
            { name: "repository-ingestion-child" },
          )
        } catch (err: unknown) {
          const normalized = err instanceof Error ? err : new Error(String(err))

          await step
            .run({ name: "mark-failed" }, () =>
              withOrgDbContext(input.orgId, () =>
                markRepositoryIndexingFailed({
                  repositoryId: input.repositoryId,
                  error: normalized,
                }),
              ),
            )
            .catch((markErr: unknown) => {
              getLogger().error(
                markErr instanceof Error ? markErr : new Error(String(markErr)),
                {
                  step: "repository-ingestion-orchestrator.mark-failed",
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
