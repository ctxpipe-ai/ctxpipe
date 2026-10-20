import { sql } from "drizzle-orm"
import { getSystemDb } from "../../db/client.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { INGESTION_V2_WORKFLOW_NAME } from "./ingestion-run.js"

/**
 * The turn of an ingestion v2 run to pin its Workspace revisions (CTX-895).
 * Two runs of one source that pin the same revision race at publish: the
 * later publish finds each file of the run changed on the default branch,
 * and only the merge model can join them. So a run waits while an earlier
 * active run of the same source (not a shadow run) can publish to one of its
 * Workspaces, for example a push during a re-ingestion. It then pins the
 * revision that the earlier run published. A run waits only for an earlier
 * run, so two runs never wait for each other.
 */
export async function ingestPublishTurn(input: {
  orgId: string
  runId: string
  sourceUrl: string
  /** The Workspaces of the run; undefined is each Workspace of the source. */
  destinations: readonly string[] | undefined
}): Promise<{ turn: true } | { wait: string }> {
  const result = await getSystemDb().execute<{ earlier: string }>(sql`
    select count(*) as earlier
    from openworkflow.workflow_runs other, openworkflow.workflow_runs me
    where me.namespace_id = ${openWorkflowNamespaceId()}
      and me.id = ${input.runId}
      and other.namespace_id = me.namespace_id
      and other.workflow_name = ${INGESTION_V2_WORKFLOW_NAME}
      and other.status in ('pending', 'running', 'sleeping')
      and other.input->>'orgId' = ${input.orgId}
      and other.input->>'shadow' = 'false'
      and lower(other.input->'source'->>'url') = ${input.sourceUrl.toLowerCase()}
      and (other.created_at, other.id) < (me.created_at, me.id)
      and ${
        input.destinations
          ? sql`(other.input->'destinations' is null
              or exists (select 1
                from jsonb_array_elements_text(other.input->'destinations') d
                where d in (${sql.join(
                  input.destinations.map((id) => sql`${id}`),
                  sql`, `,
                )})))`
          : sql`true`
      }
  `)
  return Number(result.rows[0]?.earlier ?? 0) > 0
    ? {
        wait: "An earlier ingestion run of this source publishes to the same Workspace. This run starts after it.",
      }
    : { turn: true }
}
