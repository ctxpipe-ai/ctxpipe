import { sql } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"

/**
 * `<workspaceId>:<sha>` for each hydrate run of the org that is not finished.
 * The workspace row does not record a hydrate in progress, so the run queue
 * is the source.
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
    `),
  )
  return new Set(result.rows.map((row) => row.key))
}
