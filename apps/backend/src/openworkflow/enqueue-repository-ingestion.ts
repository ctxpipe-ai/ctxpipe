import type { Workflow } from "openworkflow"
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

/** OpenWorkflow `step` from a workflow handler (`run` / `runWorkflow` / `sleep`). */
export type RepositoryIngestionChildStep = Parameters<
  Workflow<unknown, unknown, unknown>["fn"]
>[0]["step"]

/**
 * Marks the repo as mid-ingestion for the UI, then enqueues repository-ingestion-orchestrator.
 * Skips starting another orchestrator when indexing is already `queued` or `running`,
 * unless that status is stale (`queued` > 30min or `running` > 6h).
 * Awaits the DB claim so callers can return HTTP 200 after the UI can poll status.
 * Does not await workflow completion; failures are handled inside the workflow.
 *
 * External entry only (HTTP/webhooks). In-workflow callers use
 * {@link claimAndRunRepositoryIngestionChild}.
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
      await runWorkflowWithWorkerWake(
        repositoryIngestionOrchestrator.spec,
        input,
      )
    } catch (err: unknown) {
      const normalized = err instanceof Error ? err : new Error(String(err))
      log.error(normalized)
    }
  })()
}

/**
 * Claim indexing, then start repository-ingestion-orchestrator as a durable
 * child via `step.runWorkflow` so the parent sleeps and frees its concurrency
 * slot while ingestion runs.
 *
 * In-workflow entry only. External callers use {@link enqueueRepositoryIngestionWorkflow}.
 */
export async function claimAndRunRepositoryIngestionChild(
  step: RepositoryIngestionChildStep,
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  const shouldEnqueue = await step.run(
    { name: `claim-ingest-${input.repositoryId}` },
    () =>
      withOrgDbContext(input.orgId, () =>
        tryClaimRepositoryIndexingEnqueue({
          repositoryId: input.repositoryId,
          reason: input.indexingReason ?? null,
        }),
      ),
  )
  if (!shouldEnqueue) {
    return
  }

  try {
    await step.runWorkflow(repositoryIngestionOrchestrator.spec, input, {
      name: `ingest-${input.repositoryId}`,
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "SleepSignal") {
      throw err
    }
    const normalized = err instanceof Error ? err : new Error(String(err))
    log.error(normalized)
    throw normalized
  }
}
