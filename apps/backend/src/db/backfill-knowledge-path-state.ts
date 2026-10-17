import type { Pool } from "pg"

/** Upgrade-only owner operation; runtime reads never fold historical jobs. */
export async function backfillKnowledgePathState(pool: Pool): Promise<void> {
  await pool.query(`
    insert into workspace_knowledge_path_state (workspace_id, org_id, revision, paths)
    select w.id, w.org_id,
      jsonb_build_object('workspaceId', w.id, 'generation', w.desired_generation,
        'remote', jsonb_build_object('url', w.workspace_repository_url, 'connectionId', w.github_connection_id),
        'defaultBranch', w.desired_default_branch, 'sha', w.desired_sha, 'access', 'write-default'),
      assignments.paths
    from workspaces w
    cross join lateral (
      select jsonb_object_agg(latest.key, latest.value) as paths
      from (
        select distinct on (entry.key) entry.key, entry.value
        from workspace_write_jobs j
        left join openworkflow.workflow_runs owner
          on owner.id::text = j.payload->>'workflowRunId'
          and owner.input->>'orgId' = j.org_id
          and owner.input->>'workspaceId' = j.workspace_id
          and owner.input->>'jobId' = j.id
          and owner.status in ('completed', 'succeeded')
        cross join lateral jsonb_each_text(
          case when jsonb_typeof(j.payload->'knowledgePaths') = 'object'
            then j.payload->'knowledgePaths' else '{}'::jsonb end
        ) entry
        where j.workspace_id = w.id and j.org_id = w.org_id
          and j.generation = w.desired_generation and j.status = 'completed'
          and j.payload->>'jobWorkspaceUrl' = w.workspace_repository_url
          and j.payload->'revision'->>'defaultBranch' = w.desired_default_branch
          and (j.payload->'revision'->'remote'->>'connectionId') is not distinct from w.github_connection_id
        order by entry.key, coalesce(owner.finished_at, j.created_at) desc, j.id desc
      ) latest
    ) assignments
    where w.desired_sha is not null and w.desired_default_branch is not null
      and assignments.paths is not null
      and not exists (select 1 from workspace_knowledge_path_state state where state.workspace_id = w.id)
    on conflict (workspace_id) do nothing
  `)
}
