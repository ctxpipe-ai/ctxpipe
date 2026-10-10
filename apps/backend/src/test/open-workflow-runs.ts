import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import postgres from "postgres"

/**
 * Cancels the open runs in the "default" OpenWorkflow namespace that were
 * created at or after `since`, and returns their ids. A worker claims every
 * open run in its namespace, also runs it does not implement, so open runs
 * that one test file leaves make the workers of the next file slow. Each run
 * is canceled through OpenWorkflow, so a parent run that waits on it wakes.
 */
export async function cancelOpenWorkflowRunsSince(
  databaseUrl: string,
  since: Date,
): Promise<string[]> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 2,
    onnotice: () => undefined,
  })
  const ids = await sql<{ id: string }[]>`
      select id from openworkflow.workflow_runs
      where namespace_id = 'default'
        and status in ('pending', 'running', 'sleeping')
        and created_at >= ${since}
    `
    .then((rows) => rows.map((row) => row.id))
    .finally(() => sql.end())
  if (ids.length === 0) return []
  const backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
  })
  try {
    const ow = new OpenWorkflow({ backend })
    for (const id of ids) await ow.cancelWorkflowRun(id)
    return ids
  } finally {
    await backend.stop()
  }
}
