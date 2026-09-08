import type { Pool } from "pg"

/** Upgrade-only current ownership metadata; never starts work or replaces a current request. */
export async function backfillRepositoryIngestionRequests(
  pool: Pool,
): Promise<void> {
  await pool.query(`
    insert into repository_ingestion_requests
      (repository_id, org_id, request_id, target_branch, indexing_reason,
       repository_url, github_connection_id, workflow_run_id, created_at)
    select repository.id, repository.org_id,
      coalesce(owner.input->>'requestId', 'legacy:' || owner.id),
      owner.input->>'targetBranch', owner.input->>'indexingReason',
      repository.git_url, repository.github_connection_id, owner.id, owner.created_at
    from repositories repository
    cross join lateral (
      select id, input, created_at from openworkflow.workflow_runs
      where workflow_name = 'repository-ingestion-orchestrator'
        and input->>'orgId' = repository.org_id
        and input->>'repositoryId' = repository.id
      order by created_at desc, id desc limit 1
    ) owner
    where not exists (select 1 from repository_ingestion_requests request
      where request.repository_id = repository.id)
    on conflict (repository_id) do nothing
  `)
}
