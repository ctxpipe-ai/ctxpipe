import { withOrgDbContext } from "../db/client.js"
import {
  markRepositoryIndexingFailed,
  markRepositoryIndexingPending,
} from "../models/repositories.js"
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
 * Awaits the DB update so callers can return HTTP 200 after the UI can poll status.
 * Failed status is persisted only when OpenWorkflow returns terminal failure.
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

  void (async () => {
    try {
      const run = await runWorkflowWithWorkerWake(repositoryIngestion.spec, {
        repositoryId: input.repositoryId,
        orgId: input.orgId,
        ...(input.indexingReason !== undefined
          ? { indexingReason: input.indexingReason }
          : {}),
      })
      await run.result()
    } catch (err: unknown) {
      const normalized = err instanceof Error ? err : new Error(String(err))
      await withOrgDbContext(input.orgId, () =>
        markRepositoryIndexingFailed({
          repositoryId: input.repositoryId,
          error: normalized,
        }),
      ).catch((markErr: unknown) => {
        log.error(
          markErr instanceof Error ? markErr : new Error(String(markErr)),
        )
      })
      log.error(normalized)
    }
  })()
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
    const run = await runWorkflowWithWorkerWake(repositoryIngestion.spec, {
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      ...(input.indexingReason !== undefined
        ? { indexingReason: input.indexingReason }
        : {}),
    })
    await run.result()
  } catch (err: unknown) {
    const normalized = err instanceof Error ? err : new Error(String(err))
    await withOrgDbContext(input.orgId, () =>
      markRepositoryIndexingFailed({
        repositoryId: input.repositoryId,
        error: normalized,
      }),
    )
    log.error(normalized)
    throw err
  }
}
