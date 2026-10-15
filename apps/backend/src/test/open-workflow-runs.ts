import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import postgres from "postgres"

/**
 * Cancels the open runs of one OpenWorkflow namespace and returns their ids.
 * Each test file has its own namespace, so its open runs cannot slow the
 * workers of another file. Each run is canceled through OpenWorkflow, so a
 * parent run that waits on it wakes.
 */
export async function cancelOpenWorkflowRuns(
  databaseUrl: string,
  namespaceId: string,
): Promise<string[]> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 2,
    onnotice: () => undefined,
  })
  const ids = await sql<{ id: string }[]>`
      select id from openworkflow.workflow_runs
      where namespace_id = ${namespaceId}
        and status in ('pending', 'running', 'sleeping')
    `
    .then((rows) => rows.map((row) => row.id))
    .finally(() => sql.end())
  if (ids.length === 0) return []
  const backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId,
  })
  try {
    const ow = new OpenWorkflow({ backend })
    for (const id of ids) await ow.cancelWorkflowRun(id)
    return ids
  } finally {
    await backend.stop()
  }
}
