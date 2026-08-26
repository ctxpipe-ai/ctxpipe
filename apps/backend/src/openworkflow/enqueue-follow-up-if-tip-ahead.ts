import { withOrgDbContext } from "../db/client.js"
import { resolveRepositoryRef } from "../domain/codeIngestion/queue.js"
import {
  markRepositoryIndexingFailed,
  tryClaimRepositoryIndexingEnqueue,
} from "../models/repositories.js"
import { runWorkflowWithWorkerWake } from "./client.js"

export type EnqueueFollowUpIfTipAheadInput = {
  orgId: string
  repositoryId: string
  /** Commit hash this run just marked ready. */
  ingestedHash: string
  githubConnectionId?: string | null
  targetBranch?: string | null
}

/**
 * After a successful ingest, if the branch tip has moved past `ingestedHash`
 * (e.g. pushes arrived while this run was in flight), claim and start one
 * follow-up orchestrator for this repository. Errors are logged and swallowed
 * so a tip-check failure cannot undo a successful ingest.
 *
 * Does not run on failure paths — next push or manual retry catches up.
 *
 * Orchestrator is loaded lazily so this module can be imported from
 * `repository-ingestion` without a circular dependency through the orchestrator.
 */
export async function enqueueFollowUpIfTipAhead(
  input: EnqueueFollowUpIfTipAheadInput,
  log: { error: (err: Error) => void },
): Promise<{ enqueued: boolean; tipHash?: string }> {
  try {
    const tip = await resolveRepositoryRef({
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      branch: input.targetBranch ?? undefined,
      githubConnectionId: input.githubConnectionId,
    })
    if (tip.hash === input.ingestedHash) {
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

    void (async () => {
      try {
        const { repositoryIngestionOrchestrator } = await import(
          "./workflows/repository-ingestion-orchestrator.js"
        )
        await runWorkflowWithWorkerWake(repositoryIngestionOrchestrator.spec, {
          repositoryId: input.repositoryId,
          orgId: input.orgId,
          indexingReason: "follow-up",
          ...(input.targetBranch !== undefined && input.targetBranch !== null
            ? { targetBranch: input.targetBranch }
            : {}),
        })
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
        log.error(normalized)
      }
    })()

    return { enqueued: true, tipHash: tip.hash }
  } catch (err: unknown) {
    const normalized = err instanceof Error ? err : new Error(String(err))
    log.error(normalized)
    return { enqueued: false }
  }
}
