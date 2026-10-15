import { sql } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"

/**
 * `<workspaceId>:<sha>` for each hydrate run of the org that is not finished.
 * The workspace row does not record a hydrate in progress, so the run queue
 * is the source. A run older than 3 hours does not count: a hydrate sets no
 * deadline, and its 10 attempts with backoff end in minutes, so such a run
 * is stuck.
 */
export async function listUnfinishedHydrateShas(
  orgId: string,
): Promise<Set<string>> {
  const result = await withOrgDbContext(orgId, () =>
    getOrgDb().execute<{ key: string }>(sql`
      select distinct (input->>'workspaceId') || ':' || (input->'revision'->>'sha') as key
      from openworkflow.workflow_runs
      where namespace_id = ${openWorkflowNamespaceId()}
        and workflow_name = 'workspace-hydrate'
        and status in ('pending', 'running', 'sleeping')
        and input->>'orgId' = ${orgId}
        and created_at > now() - interval '3 hours'
    `),
  )
  return new Set(result.rows.map((row) => row.key))
}
