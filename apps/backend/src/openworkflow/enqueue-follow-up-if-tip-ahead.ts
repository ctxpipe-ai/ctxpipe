import { withOrgDbContext } from "../db/client.js"
import { resolveRepositoryRef } from "../domain/codeIngestion/queue.js"
import {
  clearRepositoryIndexingFollowUpPending,
  hasPendingRepositoryIndexingFollowUp,
  markRepositoryIndexingFailed,
  markRepositoryIndexingFollowUpPending,
  tryClaimRepositoryIndexingEnqueue,
} from "../models/repositories.js"

export type EnqueueFollowUpIfTipAheadInput = {
  orgId: string
  repositoryId: string
  /** Commit hash this run just marked ready. */
  ingestedHash?: string
  /** On a failed run, retry only when another request overlapped it. */
  pendingOnly?: boolean
  githubConnectionId?: string | null
  targetBranch?: string | null
}

/**
 * After a successful ingest, or after a failed ingest with an overlapping
 * request, claim and start one follow-up orchestrator for the current tip.
 * Errors preserve the pending marker and throw so a durable workflow step can
 * retry instead of silently losing the request.
 *
 * Orchestrator is loaded lazily so this module can be imported from
 * `repository-ingestion` without a circular dependency through the orchestrator.
 */
export async function enqueueFollowUpIfTipAhead(
  input: EnqueueFollowUpIfTipAheadInput,
  log: { error: (err: Error) => void },
): Promise<{ enqueued: boolean; tipHash?: string }> {
  if (input.pendingOnly) {
    const pending = await withOrgDbContext(input.orgId, () =>
      hasPendingRepositoryIndexingFollowUp({
        repositoryId: input.repositoryId,
      }),
    )
    if (!pending) return { enqueued: false }
  }

  try {
    const tip = await resolveRepositoryRef({
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      branch: input.targetBranch ?? undefined,
      githubConnectionId: input.githubConnectionId,
    })
    const ingestedHash = input.ingestedHash
    if (ingestedHash !== undefined && tip.hash === ingestedHash) {
      await withOrgDbContext(input.orgId, () =>
        clearRepositoryIndexingFollowUpPending({
          repositoryId: input.repositoryId,
          ingestedHash,
        }),
      )
      return { enqueued: false, tipHash: tip.hash }
    }

    const shouldEnqueue = await withOrgDbContext(input.orgId, () =>
      tryClaimRepositoryIndexingEnqueue({
        repositoryId: input.repositoryId,
        reason: "follow-up",
      }),
    )
    if (!shouldEnqueue) {
      return { enqueued: false, tipHash: tip.hash }
    }

    try {
      const { startClaimedRepositoryIngestionWorkflow } = await import(
        "./enqueue-repository-ingestion.js"
      )
      await startClaimedRepositoryIngestionWorkflow(
        {
          repositoryId: input.repositoryId,
          orgId: input.orgId,
          indexingReason: "follow-up",
          idempotencyKey: `follow-up-tip:${input.repositoryId}:${tip.hash}`,
          ...(input.githubConnectionId !== undefined
            ? { githubConnectionId: input.githubConnectionId }
            : {}),
          ...(input.targetBranch !== undefined && input.targetBranch !== null
            ? { targetBranch: input.targetBranch }
            : {}),
        },
        log,
      )
      return { enqueued: true, tipHash: tip.hash }
    } catch (err: unknown) {
      const normalized = err instanceof Error ? err : new Error(String(err))
      try {
        await withOrgDbContext(input.orgId, () =>
          markRepositoryIndexingFailed({
            repositoryId: input.repositoryId,
            error: normalized,
          }),
        )
      } catch (claimError) {
        log.error(
          claimError instanceof Error
            ? claimError
            : new Error(String(claimError)),
        )
      }
      throw normalized
    }
  } catch (err: unknown) {
    const normalized = err instanceof Error ? err : new Error(String(err))
    try {
      await withOrgDbContext(input.orgId, () =>
        markRepositoryIndexingFollowUpPending({
          repositoryId: input.repositoryId,
        }),
      )
    } catch (pendingError) {
      log.error(
        pendingError instanceof Error
          ? pendingError
          : new Error(String(pendingError)),
      )
    }
    log.error(normalized)
    throw normalized
  }
}
