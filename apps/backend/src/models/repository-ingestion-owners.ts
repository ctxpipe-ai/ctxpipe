import { sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { userFacingIndexingError } from "../lib/memoryFitError.js"
import type { RepositoryWithSearch } from "./repositories.js"

/** Native execution is authoritative even when cancellation prevented a worker callback. */
export async function projectRepositoryIngestionOwners(
  db: Db,
  orgId: string,
  repositories: RepositoryWithSearch[],
): Promise<RepositoryWithSearch[]> {
  if (!repositories.length) return repositories
  const owners = await db.execute<{
    repositoryId: string
    status: string
    error: { message?: string } | null
    finishedAt: string | null
  }>(sql`
    select request.repository_id as "repositoryId", owner.status, owner.error, owner.finished_at::text as "finishedAt"
    from repository_ingestion_requests request
    join repositories repository on repository.id = request.repository_id and repository.org_id = request.org_id
      and repository.git_url = request.repository_url
      and repository.github_connection_id is not distinct from request.github_connection_id
    join openworkflow.workflow_runs owner on owner.id = coalesce(request.workflow_run_id,
      (select id from openworkflow.workflow_runs where namespace_id = 'default' and workflow_name = 'repository-ingestion-orchestrator' and version is null and idempotency_key = request.request_id limit 1))
    where owner.namespace_id = 'default' and owner.version is null
      and owner.workflow_name = 'repository-ingestion-orchestrator'
      and request.org_id = ${orgId} and owner.input->>'orgId' = ${orgId}
      and owner.input->>'repositoryId' = request.repository_id
      and request.repository_id in (${sql.join(
        repositories.map((row) => sql`${row.id}`),
        sql`, `,
      )})
  `)
  const byRepository = new Map(
    owners.rows.map((owner) => [owner.repositoryId, owner]),
  )
  return repositories.map((repository) => {
    const owner = byRepository.get(repository.id)
    if (!owner || repository.indexingStatus === "unindexing") return repository
    if (!["failed", "canceled"].includes(owner.status))
      return {
        ...repository,
        indexingStatus:
          owner.status === "pending"
            ? "queued"
            : ["running", "sleeping"].includes(owner.status)
              ? "running"
              : repository.indexingStatus === "complete_with_issues"
                ? "complete_with_issues"
                : "ready",
        indexingError:
          ["completed", "succeeded"].includes(owner.status) &&
          repository.indexingStatus === "complete_with_issues"
            ? repository.indexingError
            : null,
        indexingFailedAt: null,
      }
    return {
      ...repository,
      indexingStatus: "failed",
      indexingError: userFacingIndexingError(
        owner.error?.message ??
          (owner.status === "canceled"
            ? "Repository ingestion canceled"
            : "Repository ingestion failed"),
      ).slice(0, 500),
      indexingFailedAt: owner.finishedAt
        ? new Date(owner.finishedAt)
        : repository.indexingFailedAt,
      indexingStep: null,
      indexingStepTotal: null,
      indexingStepKey: null,
    }
  })
}
