import { sql } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../domain/ingestion/ingestion-run.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"

/** A finished ingestion v2 shadow run and the old run that started it. */
export type ShadowRunPair = {
  shadowRunId: string
  status: string
  input: unknown
  output: unknown
  shadowStartedAt: Date | null
  shadowFinishedAt: Date | null
  /** The `repository-ingestion-orchestrator` run; null when it is gone. */
  oldRunId: string | null
  oldStartedAt: Date | null
  oldFinishedAt: Date | null
}

const date = (value: string | Date | null) => (value ? new Date(value) : null)

/**
 * The finished shadow runs of an org (T20). The shadow trigger uses
 * `ingestion-v2-shadow:<old run id>` as the idempotency key, so the key
 * finds the old run on the same SHA. With `runIds`, only those runs.
 */
export async function finishedShadowRunPairs(input: {
  orgId: string
  runIds?: readonly string[]
  since?: Date
  limit?: number
}): Promise<ShadowRunPair[]> {
  const namespaceId = openWorkflowNamespaceId()
  const result = await withOrgDbContext(input.orgId, () =>
    getOrgDb().execute<{
      id: string
      status: string
      input: unknown
      output: unknown
      started_at: string | Date | null
      finished_at: string | Date | null
      old_id: string | null
      old_started_at: string | Date | null
      old_finished_at: string | Date | null
    }>(sql`
      select v.id, v.status, v.input, v.output, v.started_at, v.finished_at,
        o.id as old_id, o.started_at as old_started_at,
        o.finished_at as old_finished_at
      from openworkflow.workflow_runs v
      left join openworkflow.workflow_runs o
        on o.namespace_id = v.namespace_id
        and v.idempotency_key = 'ingestion-v2-shadow:' || o.id
      where v.namespace_id = ${namespaceId}
        and v.workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
        and v.input->>'orgId' = ${input.orgId}
        and v.input->>'shadow' = 'true'
        and v.status in ('completed', 'succeeded')
        ${input.since ? sql`and v.finished_at >= ${input.since.toISOString()}::timestamptz` : sql``}
        ${
          input.runIds
            ? input.runIds.length
              ? sql`and v.id in (${sql.join(
                  input.runIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`
              : sql`and false`
            : sql``
        }
      order by v.finished_at, v.id
      limit ${input.limit ?? 100}
    `),
  )
  return result.rows.map((row) => ({
    shadowRunId: row.id,
    status: row.status,
    input: row.input,
    output: row.output,
    shadowStartedAt: date(row.started_at),
    shadowFinishedAt: date(row.finished_at),
    oldRunId: row.old_id,
    oldStartedAt: date(row.old_started_at),
    oldFinishedAt: date(row.old_finished_at),
  }))
}
