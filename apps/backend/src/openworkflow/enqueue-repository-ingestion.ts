import type { Workflow } from "openworkflow"
import { withOrgDbContext } from "../db/client.js"
import { resolveRepositoryRef } from "../domain/codeIngestion/queue.js"
import {
  getRepositoryForOrg,
  tryClaimRepositoryIndexingEnqueue,
} from "../models/repositories.js"
import {
  activateRepositoryIngestionRequest,
  findRepositoryIngestionOwner,
  prepareRepositoryIngestionRequest,
  type RepositoryIngestionIntent,
} from "../models/repository-ingestion-requests.js"
import { createLogger, withLogger } from "../observability/logger.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { isWorkflowControlSignal } from "./isSleepSignal.js"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"
import { repositoryIngestionOrchestrator } from "./workflows/repository-ingestion-orchestrator.js"

export type RepositoryIngestionEnqueueInput = RepositoryIngestionIntent & {
  afterRequestId?: string
  /**
   * Ignore the last ingested commit: codesearch runs in full mode and the
   * workflow sweeps evidence the run did not re-observe. Manual re-index only;
   * webhook-driven ingests stay incremental.
   */
  fullReingest?: boolean
  /** Used only to resolve the correct repository tip after a duplicate run. */
  githubConnectionId?: string | null
}

export type ConnectorRepositoryIngestionInput = Omit<
  RepositoryIngestionEnqueueInput,
  "githubConnectionId"
>

/** OpenWorkflow `step` from a workflow handler (`run` / `runWorkflow` / `sleep`). */
export type RepositoryIngestionChildStep = Parameters<
  Workflow<unknown, unknown, unknown>["fn"]
>[0]["step"]

/** Acknowledge one native owner before publishing queued state; retry a lost acknowledgement by its key. */
export async function enqueueRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<{ workflowRunId: string }> {
  const intent = await prepareRepositoryIngestionRequest({
    orgId: input.orgId,
    repositoryId: input.repositoryId,
    targetBranch: input.targetBranch,
    indexingReason: input.indexingReason,
    afterRequestId: input.afterRequestId,
  })
  const captured = {
    orgId: intent.orgId,
    repositoryId: intent.repositoryId,
    targetBranch: intent.targetBranch,
    indexingReason: intent.indexingReason,
    requestId: intent.requestId,
    ...(input.fullReingest !== undefined
      ? { fullReingest: input.fullReingest }
      : {}),
    ...(input.githubConnectionId !== undefined
      ? { githubConnectionId: input.githubConnectionId }
      : {}),
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

/**
 * Claim indexing, then start repository-ingestion-orchestrator as a durable
 * child via `step.runWorkflow` so the parent parks and frees its concurrency
 * slot while ingestion runs.
 *
 * In-workflow entry only. External callers use {@link enqueueRepositoryIngestionWorkflow}.
 * Connector syncs that must recover an uncheckpointed Git write should use
 * {@link runConnectorRepositoryIngestionWorkflow}.
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
    if (isWorkflowControlSignal(err)) {
      throw err
    }
    const normalized = err instanceof Error ? err : new Error(String(err))
    log.error(normalized)
    throw normalized
  }
}

/**
 * Ingest the connector branch tip, including when a Git write succeeded but
 * its workflow step result was not checkpointed.
 *
 * In-workflow entry only. Uses {@link claimAndRunRepositoryIngestionChild} so
 * the parent frees its concurrency slot while ingestion runs.
 */
export async function runConnectorRepositoryIngestionWorkflow(
  step: RepositoryIngestionChildStep,
  input: ConnectorRepositoryIngestionInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  await withLogger(
    createLogger({
      workflow: "connector-repository-ingestion",
      orgId: input.orgId,
      repositoryId: input.repositoryId,
    }),
    async () => {
      const repository = await getRepositoryForOrg(
        input.orgId,
        input.repositoryId,
      )
      if (!repository) {
        throw new Error(`Repository ${input.repositoryId} was not found`)
      }
      const tip = await resolveRepositoryRef({
        repositoryId: input.repositoryId,
        orgId: input.orgId,
        branch: input.targetBranch ?? undefined,
        githubConnectionId: repository.githubConnectionId,
      })
      if (tip.hash === repository.lastIngestedHash) return

      await claimAndRunRepositoryIngestionChild(
        step,
        {
          repositoryId: input.repositoryId,
          orgId: input.orgId,
          ...(input.targetBranch !== undefined
            ? { targetBranch: input.targetBranch }
            : {}),
          ...(input.indexingReason !== undefined
            ? { indexingReason: input.indexingReason }
            : {}),
          ...(input.fullReingest !== undefined
            ? { fullReingest: input.fullReingest }
            : {}),
          githubConnectionId: repository.githubConnectionId,
        },
        log,
      )
    },
  )
}
