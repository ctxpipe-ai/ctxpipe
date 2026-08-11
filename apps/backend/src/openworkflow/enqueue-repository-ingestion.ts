import { withOrgDbContext } from "../db/client.js"
import { tryClaimRepositoryIndexingEnqueue } from "../models/repositories.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { repositoryIngestionOrchestrator } from "./workflows/repository-ingestion-orchestrator.js"

export type RepositoryIngestionEnqueueInput = {
  repositoryId: string
  orgId: string
  /** Prefer the connector binding branch over resolving remote HEAD. */
  targetBranch?: string | null
  /** Shown in the repositories UI while ingestion runs; cleared on success. */
  indexingReason?: string | null
}

/**
 * Marks the repo as mid-ingestion for the UI, then enqueues repository-ingestion-orchestrator.
 * Skips starting another orchestrator when indexing is already `queued` or `running`,
 * unless that status is stale (`queued` > 30min or `running` > 6h).
 * Awaits the DB claim so callers can return HTTP 200 after the UI can poll status.
 * Does not await workflow completion; failures are handled inside the workflow.
 */
export async function enqueueRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  // Enqueue is the network-level entry for webhooks (no request context), so
  // we establish org DB context here before calling the model.
  const shouldEnqueue = await withOrgDbContext(input.orgId, () =>
    tryClaimRepositoryIndexingEnqueue({
      repositoryId: input.repositoryId,
      reason: input.indexingReason ?? null,
    }),
  )
  if (!shouldEnqueue) {
    return
  }

  void (async () => {
    try {
      await runWorkflowWithWorkerWake(repositoryIngestionOrchestrator.spec, {
        repositoryId: input.repositoryId,
        orgId: input.orgId,
        ...(input.targetBranch !== undefined
          ? { targetBranch: input.targetBranch }
          : {}),
        ...(input.indexingReason !== undefined
          ? { indexingReason: input.indexingReason }
          : {}),
      })
    } catch (err: unknown) {
      const normalized = err instanceof Error ? err : new Error(String(err))
      log.error(normalized)
    }
  })()
}

/** Await ingestion workflow (e.g. parent sync workflow). */
export async function runRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  const shouldEnqueue = await withOrgDbContext(input.orgId, () =>
    tryClaimRepositoryIndexingEnqueue({
      repositoryId: input.repositoryId,
      reason: input.indexingReason ?? null,
    }),
  )
  if (!shouldEnqueue) {
    return
  }

  try {
    await runWorkflowWithWorkerWake(repositoryIngestionOrchestrator.spec, {
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      ...(input.targetBranch !== undefined
        ? { targetBranch: input.targetBranch }
        : {}),
      ...(input.indexingReason !== undefined
        ? { indexingReason: input.indexingReason }
        : {}),
    })
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
    throw err
  }
}
