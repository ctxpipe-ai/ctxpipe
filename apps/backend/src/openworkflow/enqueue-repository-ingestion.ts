import {
  activateRepositoryIngestionRequest,
  findRepositoryIngestionOwner,
  prepareRepositoryIngestionRequest,
  type RepositoryIngestionIntent,
} from "../models/repository-ingestion-requests.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"
import { repositoryIngestionOrchestrator } from "./workflows/repository-ingestion-orchestrator.js"

export type RepositoryIngestionEnqueueInput = RepositoryIngestionIntent & {
  afterRequestId?: string
}

/** Acknowledge one native owner before publishing queued state; retry a lost acknowledgement by its key. */
export async function enqueueRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<{ workflowRunId: string }> {
  const intent = await prepareRepositoryIngestionRequest(input)
  const captured = {
    orgId: intent.orgId,
    repositoryId: intent.repositoryId,
    targetBranch: intent.targetBranch,
    indexingReason: intent.indexingReason,
    requestId: intent.requestId,
  }
  let workflowRunId: string
  try {
    const handle = await runWorkflowWithWorkerWake(
      repositoryIngestionOrchestrator.spec,
      captured,
      { idempotencyKey: intent.requestId },
    )
    workflowRunId = handle.workflowRun.id
  } catch (error) {
    const recovered = await findRepositoryIngestionOwner(captured)
    if (!recovered) {
      log.error(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    workflowRunId = recovered
    scheduleEnsureWorkerRunning()
  }
  await activateRepositoryIngestionRequest(captured, workflowRunId)
  return { workflowRunId }
}

/** Parent callbacks await durable admission, while OpenWorkflow owns subsequent execution. */
export const runRepositoryIngestionWorkflow = enqueueRepositoryIngestionWorkflow
