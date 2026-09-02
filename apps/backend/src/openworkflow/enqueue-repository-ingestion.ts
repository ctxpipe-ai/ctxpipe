import type { Workflow } from "openworkflow"
import { withOrgDbContext } from "../db/client.js"
import { resolveRepositoryRef } from "../domain/codeIngestion/queue.js"
import {
  getRepositoryForOrg,
  markRepositoryIndexingFailed,
  markRepositoryIndexingReady,
  tryClaimRepositoryIndexingEnqueue,
} from "../models/repositories.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { enqueueFollowUpIfTipAhead } from "./enqueue-follow-up-if-tip-ahead.js"
import { repositoryIngestionOrchestrator } from "./workflows/repository-ingestion-orchestrator.js"

export type RepositoryIngestionEnqueueInput = {
  repositoryId: string
  orgId: string
  /** Prefer the connector binding branch over resolving remote HEAD. */
  targetBranch?: string | null
  /** Shown in the repositories UI while ingestion runs; cleared on success. */
  indexingReason?: string | null
  /** Stable source-tip identity used to deduplicate ambiguous enqueue retries. */
  idempotencyKey?: string
  /** Used only to resolve the correct repository tip after a duplicate run. */
  githubConnectionId?: string | null
}

export type ConnectorRepositoryIngestionInput = Omit<
  RepositoryIngestionEnqueueInput,
  "githubConnectionId" | "idempotencyKey"
>

/** OpenWorkflow `step` from a workflow handler (`run` / `runWorkflow` / `sleep`). */
export type RepositoryIngestionChildStep = Parameters<
  Workflow<unknown, unknown, unknown>["fn"]
>[0]["step"]

async function failRepositoryIngestionClaim(
  input: RepositoryIngestionEnqueueInput,
  error: Error,
  log: { error: (err: Error) => void },
): Promise<void> {
  try {
    await withOrgDbContext(input.orgId, () =>
      markRepositoryIndexingFailed({
        repositoryId: input.repositoryId,
        error,
      }),
    )
  } catch (claimError) {
    log.error(
      claimError instanceof Error ? claimError : new Error(String(claimError)),
    )
    return
  }
  try {
    await enqueueFollowUpIfTipAhead(
      {
        orgId: input.orgId,
        repositoryId: input.repositoryId,
        githubConnectionId: input.githubConnectionId,
        targetBranch: input.targetBranch,
        pendingOnly: true,
      },
      log,
    )
  } catch (followUpError) {
    log.error(
      followUpError instanceof Error
        ? followUpError
        : new Error(String(followUpError)),
    )
  }
}

function startRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
) {
  const workflowInput = {
    repositoryId: input.repositoryId,
    orgId: input.orgId,
    ...(input.targetBranch !== undefined
      ? { targetBranch: input.targetBranch }
      : {}),
    ...(input.indexingReason !== undefined
      ? { indexingReason: input.indexingReason }
      : {}),
    ...(input.githubConnectionId !== undefined
      ? { githubConnectionId: input.githubConnectionId }
      : {}),
  }
  return input.idempotencyKey
    ? runWorkflowWithWorkerWake(
        repositoryIngestionOrchestrator.spec,
        workflowInput,
        { idempotencyKey: input.idempotencyKey },
      )
    : runWorkflowWithWorkerWake(
        repositoryIngestionOrchestrator.spec,
        workflowInput,
      )
}

type RepositoryIngestionWorkflowHandle = Awaited<
  ReturnType<typeof startRepositoryIngestionWorkflow>
>

async function reconcileTerminalIngestionRun(
  input: RepositoryIngestionEnqueueInput,
  handle: RepositoryIngestionWorkflowHandle,
  log: { error: (err: Error) => void },
): Promise<
  | { status: "accepted" }
  | { status: "failed"; error: Error; workflowRunId: string }
> {
  const workflowRun = handle.workflowRun
  switch (workflowRun.status) {
    case "pending":
    case "running":
    case "sleeping":
      return { status: "accepted" }
    case "succeeded":
    case "completed": {
      const output = workflowRun.output
      const targetHash =
        output &&
        typeof output === "object" &&
        "targetHash" in output &&
        typeof output.targetHash === "string"
          ? output.targetHash
          : undefined
      if (!targetHash) {
        throw new Error(
          `Completed repository ingestion has no target hash for ${input.repositoryId}`,
        )
      }
      await withOrgDbContext(input.orgId, () =>
        markRepositoryIndexingReady({
          repositoryId: input.repositoryId,
          targetHash,
        }),
      )
      await enqueueFollowUpIfTipAhead(
        {
          orgId: input.orgId,
          repositoryId: input.repositoryId,
          ingestedHash: targetHash,
          githubConnectionId: input.githubConnectionId,
          targetBranch: input.targetBranch,
        },
        log,
      )
      return { status: "accepted" }
    }
    case "failed":
    case "canceled": {
      const serializedError = workflowRun.error
      const message =
        serializedError &&
        typeof serializedError === "object" &&
        "message" in serializedError &&
        typeof serializedError.message === "string"
          ? serializedError.message
          : `Repository ingestion workflow is already ${workflowRun.status}`
      return {
        status: "failed",
        error: new Error(message),
        workflowRunId: workflowRun.id,
      }
    }
    default: {
      const unhandledStatus: never = workflowRun.status
      throw new Error(
        `Unhandled repository ingestion status: ${unhandledStatus}`,
      )
    }
  }
}

async function startActiveRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  let idempotencyKey = input.idempotencyKey
  const failedWorkflowRunIds = new Set<string>()
  for (;;) {
    const handle = await startRepositoryIngestionWorkflow({
      ...input,
      idempotencyKey,
    })
    const result = await reconcileTerminalIngestionRun(input, handle, log)
    if (result.status === "accepted") return
    if (
      !input.idempotencyKey ||
      failedWorkflowRunIds.has(result.workflowRunId)
    ) {
      throw result.error
    }
    failedWorkflowRunIds.add(result.workflowRunId)
    idempotencyKey = `${input.idempotencyKey}:retry:${result.workflowRunId}`
  }
}

/**
 * Start a repository ingestion after the caller has acquired the single-flight
 * database claim. Stable idempotency keys reconcile ambiguous workflow-create
 * retries without claiming the repository twice.
 */
export async function startClaimedRepositoryIngestionWorkflow(
  input: RepositoryIngestionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<void> {
  await startActiveRepositoryIngestionWorkflow(input, log)
}

/**
 * Marks the repo as mid-ingestion for the UI, then enqueues repository-ingestion-orchestrator.
 * Skips starting another orchestrator when indexing is already `queued` or `running`,
 * unless that status is stale (`queued` > 30min or `running` > 6h).
 * Awaits the DB claim and durable workflow creation before returning.
 * Does not await workflow completion; terminal failures are handled inside the workflow.
 *
 * External entry only (HTTP/webhooks). In-workflow callers use
 * {@link claimAndRunRepositoryIngestionChild} or
 * {@link runConnectorRepositoryIngestionWorkflow}.
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

  try {
    await startActiveRepositoryIngestionWorkflow(input, log)
  } catch (err: unknown) {
    const normalized = err instanceof Error ? err : new Error(String(err))
    await failRepositoryIngestionClaim(input, normalized, log)
    log.error(normalized)
  }
}

/**
 * Claim indexing, then start repository-ingestion-orchestrator as a durable
 * child via `step.runWorkflow` so the parent sleeps and frees its concurrency
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
    if (err instanceof Error && err.name === "SleepSignal") {
      throw err
    }
    const normalized = err instanceof Error ? err : new Error(String(err))
    await failRepositoryIngestionClaim(input, normalized, log)
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
  const repository = await getRepositoryForOrg(input.orgId, input.repositoryId)
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
      githubConnectionId: repository.githubConnectionId,
    },
    log,
  )
}
