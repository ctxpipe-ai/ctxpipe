import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { ingestionV2ShadowEnabled } from "../../domain/ingestion/ingestion-v2-config.js"
import {
  markRepositoryIndexingFailed,
  repositoryIngestionBlockedByDeletion,
} from "../../models/repositories.js"
import { activateRepositoryIngestionRequest } from "../../models/repository-ingestion-requests.js"
import { flushWorkflowLog, getLogger } from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import {
  startIngestionV2Publish,
  startIngestionV2Shadow,
} from "../enqueue-ingestion-v2-shadow.js"
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
    logFields: (input) => ({
      repositoryId: input.repositoryId,
      orgId: input.orgId,
    }),
    name: "repository-ingestion-orchestrator",
    schema: repositoryIngestionOrchestratorInputSchema,
  },
  async ({ input, step, run }) => {
    const requestId = await step.run(
      { name: "activate-ingestion-request" },
      () => activateRepositoryIngestionRequest(input, run.id),
    )
    try {
      const result = await step.runWorkflow(
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
      if (
        "targetHash" in result &&
        result.targetHash &&
        ingestionV2ShadowEnabled()
      )
        // Shadow mode (ADR-052): ingestion v2 reads the same SHA and
        // publishes nothing. A failed start never fails this run. The
        // switch is read before the step, so production writes no step.
        await step.run({ name: "start-ingestion-v2-shadow" }, () =>
          startIngestionV2Shadow({
            orgId: input.orgId,
            repositoryId: input.repositoryId,
            sha: result.targetHash,
            triggerRunId: run.id,
          }).catch((error: unknown) => {
            getLogger().warn("repository-ingestion-orchestrator.shadow", {
              step: "start-ingestion-v2-shadow",
              repositoryId: input.repositoryId,
              orgId: input.orgId,
              errMessage:
                error instanceof Error ? error.message : String(error),
            })
            return { started: false as const, reason: "start_failed" }
          }),
        )
      if ("targetHash" in result && result.targetHash)
        // Ingestion v2 publishes to each declaring Workspace at format 3
        // or more (ADR-052 phase 4, G5). No ingestion writes below 3. A
        // failed start never fails the indexing that it follows; the next
        // ingestion of the repository starts one.
        await step.run({ name: "start-ingestion-v2-publish" }, () =>
          startIngestionV2Publish({
            orgId: input.orgId,
            repositoryId: input.repositoryId,
            sha: result.targetHash,
            triggerRunId: run.id,
          }).catch((error: unknown) => {
            getLogger().warn("repository-ingestion-orchestrator.publish", {
              step: "start-ingestion-v2-publish",
              repositoryId: input.repositoryId,
              orgId: input.orgId,
              errMessage:
                error instanceof Error ? error.message : String(error),
            })
            return { started: false as const, reason: "start_failed" }
          }),
        )
      return result
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
)
