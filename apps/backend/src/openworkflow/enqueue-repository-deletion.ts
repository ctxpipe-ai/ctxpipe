import { assertNotInOrgDbContext, withOrgDbContext } from "../db/client.js"
import { formatUnknownError } from "../db/transientDbRetry.js"
import { markRepositoryUnindexing } from "../models/repositories.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { repositoryDeletion } from "./workflows/repository-deletion.js"

export type RepositoryDeletionEnqueueInput = {
  repositoryId: string
  orgId: string
  /** Optional; helps codesearch purge if prepare resumes after the row is gone. */
  repoName?: string
  zoektRepoId?: number
}

export type RepositoryDeletionEnqueueResult = {
  jobId: string
  status: "queued"
}

/**
 * Idempotency key for a single enqueue attempt. Includes `attemptId` (mark
 * timestamp) so UI "Retry unindexing" after a failed/crashed run starts a new
 * workflow instead of reattaching to a terminal failed run.
 */
export function repositoryDeletionIdempotencyKey(
  orgId: string,
  repositoryId: string,
  attemptId: string,
): string {
  return `repository-deletion:${orgId}:${repositoryId}:${attemptId}`
}

/**
 * Marks the repo as unindexing for the UI, then enqueues repository-deletion.
 *
 * Returns null when the repository row no longer exists.
 * On enqueue failure after mark, status stays `unindexing` so the UI retry path
 * can call this again (new attempt id → new workflow).
 */
export async function enqueueRepositoryDeletionWorkflow(
  input: RepositoryDeletionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<RepositoryDeletionEnqueueResult | null> {
  assertNotInOrgDbContext()
  const marked = await withOrgDbContext(input.orgId, () =>
    markRepositoryUnindexing({ repositoryId: input.repositoryId }),
  )

  if (!marked) {
    return null
  }

  const attemptId = marked.updatedAt.toISOString()

  try {
    const handle = await runWorkflowWithWorkerWake(
      repositoryDeletion.spec,
      {
        repositoryId: input.repositoryId,
        orgId: input.orgId,
        ...(input.repoName !== undefined ? { repoName: input.repoName } : {}),
        ...(input.zoektRepoId !== undefined
          ? { zoektRepoId: input.zoektRepoId }
          : {}),
      },
      {
        idempotencyKey: repositoryDeletionIdempotencyKey(
          input.orgId,
          input.repositoryId,
          attemptId,
        ),
      },
    )

    return {
      jobId: handle.workflowRun.id,
      status: "queued",
    }
  } catch (err: unknown) {
    const normalized =
      err instanceof Error ? err : new Error(formatUnknownError(err))
    log.error(normalized)
    throw normalized
  }
}
