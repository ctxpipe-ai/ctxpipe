import { sql } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import type { IngestRunState } from "../domain/ingestion/ingest-refs.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../domain/ingestion/ingestion-run.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"

/**
 * Ingestion v2 runs of an org, out of `runIds` (T08 ref clean-up and the
 * broker's run binding). A run of another org or another workflow is absent.
 * Every version of the workflow counts.
 */
export async function ingestionRunStates(
  orgId: string,
  runIds: readonly string[],
): Promise<Map<string, IngestRunState>> {
  if (!runIds.length) return new Map()
  const result = await withOrgDbContext(orgId, () =>
    getOrgDb().execute<{
      id: string
      status: string
      finished_at: string | Date | null
      shadow: boolean | null
    }>(sql`
      select id, status, finished_at, (input->>'shadow')::boolean as shadow
      from openworkflow.workflow_runs
      where namespace_id = ${openWorkflowNamespaceId()}
        and workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
        and id in (${sql.join(
          runIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        and input->>'orgId' = ${orgId}
    `),
  )
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        unfinished: ["pending", "running", "sleeping"].includes(row.status),
        finishedAt: row.finished_at ? new Date(row.finished_at) : null,
        shadow: row.shadow === true,
      },
    ]),
  )
}

/** True when the org has an unfinished ingestion v2 run, or one since `since`. */
export async function orgHasRecentIngestionRun(
  orgId: string,
  since: Date,
): Promise<boolean> {
  const result = await withOrgDbContext(orgId, () =>
    getOrgDb().execute<{ found: number }>(sql`
      select 1 as found
      from openworkflow.workflow_runs
      where namespace_id = ${openWorkflowNamespaceId()}
        and workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
        and input->>'orgId' = ${orgId}
        and (
          status in ('pending', 'running', 'sleeping')
          or coalesce(finished_at, created_at) >= ${since.toISOString()}::timestamptz
        )
      limit 1
    `),
  )
  return result.rows.length > 0
}
