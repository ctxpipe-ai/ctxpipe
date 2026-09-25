import { sql } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { log } from "../observability/logger.js"
import { ow } from "./client.js"
import { isWorkflowControlSignal } from "./isSleepSignal.js"
import { openWorkflowNamespaceId } from "./namespace.js"

const INGESTION_WORKFLOW_NAMES = [
  "repository-ingestion-orchestrator",
  "repository-ingestion",
  "repository-index",
] as const

function quoteIdent(ident: string): string {
  if (!/^[a-zA-Z_]\w*$/.test(ident)) {
    throw new Error(`Invalid OpenWorkflow schema identifier: ${ident}`)
  }
  return `"${ident}"`
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown[] }).rows
  if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : []
}

/**
 * OpenWorkflow 0.8's client cancels only by id (`ow.cancelWorkflowRun`).
 * `listWorkflowRuns` is pagination-only — no workflow name or input filter —
 * so discovering those ids has to read the backend `workflow_runs` table.
 */
async function activeIngestionRunIds(input: {
  orgId: string
  repositoryId: string
}): Promise<string[]> {
  const schema = quoteIdent(
    process.env.OPENWORKFLOW_POSTGRES_SCHEMA ?? "openworkflow",
  )
  const namespaceId = openWorkflowNamespaceId()
  const names = sql.join(
    INGESTION_WORKFLOW_NAMES.map((name) => sql`${name}`),
    sql`, `,
  )
  const result = await getSystemDb().execute(sql`
    SELECT id
    FROM ${sql.raw(schema)}.workflow_runs
    WHERE namespace_id = ${namespaceId}
      AND status IN ('pending', 'running', 'sleeping')
      AND workflow_name IN (${names})
      AND input->>'repositoryId' = ${input.repositoryId}
      AND input->>'orgId' = ${input.orgId}
  `)
  return rowsOf(result)
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
}

/**
 * Cancels in-flight ingestion for a repository so a delete does not leave
 * OpenWorkflow retrying codesearch calls. Terminal runs are ignored.
 * Returns the workflow run ids that were canceled.
 */
export async function cancelActiveRepositoryIngestion(input: {
  orgId: string
  repositoryId: string
}): Promise<string[]> {
  const ids = await activeIngestionRunIds(input)

  const canceled: string[] = []
  for (const id of ids) {
    try {
      await ow.cancelWorkflowRun(id)
      canceled.push(id)
    } catch (err: unknown) {
      if (isWorkflowControlSignal(err)) throw err
      // Client errors for a missing run and for succeeded/completed/failed.
      const message = err instanceof Error ? err.message : String(err)
      if (
        message.includes("Cannot cancel") ||
        message.includes("does not exist")
      ) {
        continue
      }
      log.error({
        step: "repository-deletion.cancel-ingestion",
        repositoryId: input.repositoryId,
        orgId: input.orgId,
        workflowRunId: id,
        error: message,
      })
    }
  }

  if (canceled.length > 0) {
    log.info({
      step: "repository-deletion.cancel-ingestion",
      repositoryId: input.repositoryId,
      orgId: input.orgId,
      workflowRunIds: canceled,
    })
  }
  return canceled
}
