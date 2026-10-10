import postgres from "postgres"

/**
 * Cancels the open runs in the "default" OpenWorkflow namespace that were
 * created at or after `since`, and returns their ids. A worker claims every
 * open run in its namespace, also runs it does not implement, so open runs
 * that one test file leaves make the workers of the next file slow.
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
  try {
    const rows = await sql<{ id: string }[]>`
      update openworkflow.workflow_runs
      set status = 'canceled', worker_id = null, available_at = null,
        finished_at = now(), updated_at = now()
      where namespace_id = 'default'
        and status in ('pending', 'running', 'sleeping')
        and created_at >= ${since}
      returning id
    `
    return rows.map((row) => row.id)
  } finally {
    await sql.end()
  }
}
