import { withOrgDbContext } from "../db/client.js"
import { markRepositoryDeletionQueued } from "../models/repositories.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { repositoryDeletion } from "./workflows/repository-deletion.js"

export type RepositoryDeletionEnqueueInput = {
  repositoryId: string
  orgId: string
}

export type RepositoryDeletionEnqueueResult = {
  jobId: string
  status: "queued"
}

export function repositoryDeletionIdempotencyKey(
  orgId: string,
  repositoryId: string,
): string {
  return `repository-deletion:${orgId}:${repositoryId}`
}

/**
 * Marks the repo as deleting for the UI, then enqueues repository-deletion.
 * Uses an idempotency key so repeated DELETE requests return the same job.
 */
export async function enqueueRepositoryDeletionWorkflow(
  input: RepositoryDeletionEnqueueInput,
  log: { error: (err: Error) => void },
): Promise<RepositoryDeletionEnqueueResult | null> {
  const marked = await withOrgDbContext(input.orgId, () =>
    markRepositoryDeletionQueued({ repositoryId: input.repositoryId }),
  )

  if (!marked) {
    return null
  }

  const handle = await runWorkflowWithWorkerWake(
    repositoryDeletion.spec,
    {
      repositoryId: input.repositoryId,
      orgId: input.orgId,
    },
    {
      idempotencyKey: repositoryDeletionIdempotencyKey(
        input.orgId,
        input.repositoryId,
      ),
    },
  ).catch((err: unknown) => {
    log.error(err instanceof Error ? err : new Error(String(err)))
    throw err
  })

  return {
    jobId: handle.workflowRun.id,
    status: "queued",
  }
}
