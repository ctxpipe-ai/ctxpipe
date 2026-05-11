import { withOrgDbContext } from "../db/client.js"
import { markRepositoryIndexingPending } from "../models/repositories.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { repositoryIngestion } from "./workflows/repository-ingestion.js"

export type RepositoryIngestionEnqueueInput = {
  repositoryId: string
  orgId: string
  /** Shown in the repositories UI while ingestion runs; cleared on success. */
  indexingReason?: string | null
}

/**
 * Marks the repo as mid-ingestion for the UI, then enqueues repository-ingestion.
 * Awaits the DB update so callers can return HTTP 200 after the UI can poll `indexReady`.
 * Workflow failures are logged; the row stays pending until a retry succeeds.
 */
export async function enqueueRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  // Enqueue is the network-level entry for webhooks (no request context), so
  // we establish org DB context here before calling the model.
  await withOrgDbContext(input.orgId, () =>
    markRepositoryIndexingPending({
      repositoryId: input.repositoryId,
      reason: input.indexingReason ?? null,
    }),
  )

  void runWorkflowWithWorkerWake(repositoryIngestion.spec, {
    repositoryId: input.repositoryId,
    orgId: input.orgId,
    ...(input.indexingReason !== undefined
      ? { indexingReason: input.indexingReason }
      : {}),
  }).catch((err: unknown) => {
    log.error(err instanceof Error ? err : new Error(String(err)))
  })
}

/** Await ingestion workflow (e.g. parent sync workflow). */
export async function runRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  await withOrgDbContext(input.orgId, () =>
    markRepositoryIndexingPending({
      repositoryId: input.repositoryId,
      reason: input.indexingReason ?? null,
    }),
  )

  try {
    await runWorkflowWithWorkerWake(repositoryIngestion.spec, {
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      ...(input.indexingReason !== undefined
        ? { indexingReason: input.indexingReason }
        : {}),
    })
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
    throw err
  }
}
