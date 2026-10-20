import { sql } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"

/** A native workflow step fails terminally; running child waits are not failures. */
export async function getSlackMentionMirrorFailure(input: {
  orgId: string
  connectionId: string
  workflowRunId: string
}): Promise<string | null> {
  return withOrgDbContext(input.orgId, async (db) => {
    const result = await db.execute<{ message: string }>(sql`
      select coalesce(attempt.error->>'message', 'Slack mirror failed') as message
      from openworkflow.workflow_runs owner
      join openworkflow.step_attempts attempt
        on attempt.namespace_id = owner.namespace_id and attempt.workflow_run_id = owner.id
      where owner.id = ${input.workflowRunId}
        and owner.workflow_name = 'slack-mention-agent'
        and owner.input->>'orgId' = ${input.orgId}
        and owner.input->>'connectionId' = ${input.connectionId}
        and attempt.step_name = 'commit-slack-mirror'
        and attempt.kind = 'workflow' and attempt.status = 'failed'
      order by attempt.created_at desc limit 1
    `)
    return result.rows[0]?.message ?? null
  })
}
