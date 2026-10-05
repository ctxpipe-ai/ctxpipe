import { resolveRepositoryRef } from "../domain/codeIngestion/queue.js"

export type EnqueueFollowUpIfTipAheadInput = {
  orgId: string
  repositoryId: string
  /** Commit hash this run just marked ready. */
  ingestedHash: string
  githubConnectionId?: string | null
  targetBranch?: string | null
  requestId?: string
}

/** Await durable admission so native step retry recovers a failed or lost acknowledgement. */
export async function enqueueFollowUpIfTipAhead(
  input: EnqueueFollowUpIfTipAheadInput,
  log: { error: (err: Error) => void },
): Promise<{ enqueued: boolean; tipHash: string; workflowRunId?: string }> {
  const tip = await resolveRepositoryRef({
    repositoryId: input.repositoryId,
    orgId: input.orgId,
    branch: input.targetBranch ?? undefined,
    githubConnectionId: input.githubConnectionId,
  })
  if (tip.hash === input.ingestedHash)
    return { enqueued: false, tipHash: tip.hash }
  // Loaded at the callback boundary to avoid the orchestrator/producer module cycle.
  const { enqueueRepositoryIngestionWorkflow } = await import(
    "./enqueue-repository-ingestion.js"
  )
  const owner = await enqueueRepositoryIngestionWorkflow(
    {
      orgId: input.orgId,
      repositoryId: input.repositoryId,
      targetBranch: input.targetBranch,
      indexingReason: "follow-up",
      afterRequestId: input.requestId,
    },
    log,
  )
  return {
    enqueued: true,
    tipHash: tip.hash,
    workflowRunId: owner.workflowRunId,
  }
}
