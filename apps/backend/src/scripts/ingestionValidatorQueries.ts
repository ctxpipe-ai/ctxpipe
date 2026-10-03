/**
 * Postgres reads for the ingestion validator and `repoGraphSizeCheck`:
 * the native OpenWorkflow run tree of one ingestion, the repository row,
 * the extraction write job, and the Workspace knowledge units it produced.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import {
  workspaceKnowledgeUnits,
  workspaces,
  workspaceWriteJobs,
} from "../db/schema/workspaces.js"

export type ValidatorRun = {
  id: string
  workflowName: string
  status: string
  parentRunId: string | null
  parentStepName: string | null
  /** Run output without per-path change lists (they can hold every file of a repository). */
  output: unknown
  error: unknown
  /** `workspace-hydrate` only: the revision SHA it was asked to project. */
  revisionSha: string | null
  /** Trace id of the `workflow_run.create` span that admitted this run. */
  traceId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type ValidatorStep = {
  runId: string
  stepName: string
  kind: string
  status: string
  startedAt: string | null
  finishedAt: string | null
  /** Kept only for the codesearch and commit steps the checks read. */
  output: unknown
  error: unknown
  childRunId: string | null
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return new Date(value as string | Date).toISOString()
}

/** `00-<trace id>-<span id>-<flags>` → trace id. */
export function traceIdFromTraceparent(
  traceparent: string | null,
): string | null {
  const traceId = traceparent?.split("-")[1]
  return traceId && /^[0-9a-f]{32}$/.test(traceId) ? traceId : null
}

/** Every run reachable from the roots through child-workflow steps, with their step attempts. */
export async function readRunTree(input: {
  orgId: string
  namespaceId: string
  rootRunIds: string[]
}): Promise<{ runs: ValidatorRun[]; steps: ValidatorStep[] }> {
  if (input.rootRunIds.length === 0) return { runs: [], steps: [] }
  const namespaceId = input.namespaceId
  const roots = sql.join(
    input.rootRunIds.map((id) => sql`${id}`),
    sql`, `,
  )
  return withOrgDbContext(input.orgId, async (db) => {
    const runRows = await db.execute<Record<string, unknown>>(sql`
      with recursive tree as (
        select run.id, null::text as parent_run_id, null::text as parent_step_name, 0 as depth
        from openworkflow.workflow_runs run
        where run.namespace_id = ${namespaceId} and run.id in (${roots})
        union all
        select child.id, attempt.workflow_run_id, attempt.step_name, tree.depth + 1
        from tree
        join openworkflow.step_attempts attempt
          on attempt.namespace_id = ${namespaceId} and attempt.workflow_run_id = tree.id
          and attempt.child_workflow_run_id is not null
        join openworkflow.workflow_runs child
          on child.namespace_id = coalesce(attempt.child_workflow_run_namespace_id, ${namespaceId})
          and child.id = attempt.child_workflow_run_id
        where tree.depth < 8
      )
      select distinct on (run.id)
        run.id, run.workflow_name, run.status, tree.parent_run_id, tree.parent_step_name,
        case when jsonb_typeof(run.output) = 'object'
          then run.output - 'changedPaths' - 'deletedPaths' - 'renames'
          else run.output end as output,
        run.error,
        case when run.workflow_name = 'workspace-hydrate'
          then run.input->'revision'->>'sha' end as revision_sha,
        run.context->'traceContext'->>'traceparent' as traceparent,
        run.created_at, run.started_at, run.finished_at
      from tree
      join openworkflow.workflow_runs run on run.namespace_id = ${namespaceId} and run.id = tree.id
      order by run.id, tree.depth
    `)
    const runs: ValidatorRun[] = runRows.rows.map((row) => ({
      id: String(row.id),
      workflowName: String(row.workflow_name),
      status: String(row.status),
      parentRunId: (row.parent_run_id as string | null) ?? null,
      parentStepName: (row.parent_step_name as string | null) ?? null,
      output: row.output ?? null,
      error: row.error ?? null,
      revisionSha: (row.revision_sha as string | null) ?? null,
      traceId: traceIdFromTraceparent(
        (row.traceparent as string | null) ?? null,
      ),
      createdAt: iso(row.created_at) ?? "",
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
    }))
    if (runs.length === 0) return { runs, steps: [] }
    const runIds = sql.join(
      runs.map((run) => sql`${run.id}`),
      sql`, `,
    )
    const stepRows = await db.execute<Record<string, unknown>>(sql`
      select workflow_run_id, step_name, kind, status, started_at, finished_at, error,
        child_workflow_run_id,
        case when step_name ~ '^(zoekt|detect-languages|scip:|merge-scip|commit$)'
          then output end as output
      from openworkflow.step_attempts
      where namespace_id = ${namespaceId} and workflow_run_id in (${runIds})
      order by created_at
    `)
    const steps: ValidatorStep[] = stepRows.rows.map((row) => ({
      runId: String(row.workflow_run_id),
      stepName: String(row.step_name),
      kind: String(row.kind),
      status: String(row.status),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      output: row.output ?? null,
      error: row.error ?? null,
      childRunId: (row.child_workflow_run_id as string | null) ?? null,
    }))
    return { runs, steps }
  })
}

/** The run a native idempotency key admitted for this workflow, if any. */
export async function findRunByIdempotencyKey(input: {
  orgId: string
  namespaceId: string
  workflowName: string
  idempotencyKey: string
}): Promise<string | null> {
  return withOrgDbContext(input.orgId, async (db) => {
    const result = await db.execute<{ id: string }>(sql`
      select id from openworkflow.workflow_runs
      where namespace_id = ${input.namespaceId} and workflow_name = ${input.workflowName}
        and idempotency_key = ${input.idempotencyKey}
      order by created_at desc limit 1
    `)
    return result.rows[0]?.id ?? null
  })
}

export type RepositoryStatus = {
  indexingStatus: string | null
  indexingError: string | null
  lastIngestedHash: string | null
  indexReady: boolean
}

export async function readRepositoryStatus(
  orgId: string,
  repositoryId: string,
): Promise<RepositoryStatus | null> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({
        indexingStatus: repositories.indexingStatus,
        indexingError: repositories.indexingError,
        lastIngestedHash: repositories.lastIngestedHash,
        indexReady: repositories.indexReady,
      })
      .from(repositories)
      .where(
        and(eq(repositories.orgId, orgId), eq(repositories.id, repositoryId)),
      ),
  )
  return row ?? null
}

export type ExtractWriteJob = {
  id: string
  status: string
  commitSha: string | null
  sourceSha: string | null
  /** Exported object key → knowledge file path written by this extraction. */
  knowledgePaths: Record<string, string>
}

/**
 * One extraction write job: by id (`wjob_<repository-ingestion run>_extract`),
 * or the latest completed one for a repository in a Workspace.
 */
export async function readExtractWriteJob(
  orgId: string,
  target: { jobId: string } | { workspaceId: string; repositoryId: string },
): Promise<ExtractWriteJob | null> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({
        id: workspaceWriteJobs.id,
        status: workspaceWriteJobs.status,
        commitSha: workspaceWriteJobs.commitSha,
        sourceSha: sql<
          string | null
        >`${workspaceWriteJobs.payload}->'extraction'->>'sourceSha'`,
        knowledgePaths: sql<Record<
          string,
          string
        > | null>`${workspaceWriteJobs.payload}->'knowledgePaths'`,
      })
      .from(workspaceWriteJobs)
      .where(
        "jobId" in target
          ? and(
              eq(workspaceWriteJobs.orgId, orgId),
              eq(workspaceWriteJobs.id, target.jobId),
            )
          : and(
              eq(workspaceWriteJobs.orgId, orgId),
              eq(workspaceWriteJobs.workspaceId, target.workspaceId),
              eq(workspaceWriteJobs.kind, "extract_ingest"),
              eq(workspaceWriteJobs.status, "completed"),
              sql`${workspaceWriteJobs.payload}->'extraction'->>'repositoryId' = ${target.repositoryId}`,
            ),
      )
      .orderBy(desc(workspaceWriteJobs.updatedAt))
      .limit(1),
  )
  return row ? { ...row, knowledgePaths: row.knowledgePaths ?? {} } : null
}

export type RepositoryUnits = {
  /** Units per front-matter kind (`(none)` for plain knowledge files). */
  kinds: Record<string, number>
  units: number
  withoutEmbedding: number
  /** Requested paths that have a unit at this projection SHA. */
  presentPaths: string[]
}

/** Knowledge units at one projection SHA whose paths an extraction wrote. */
export async function readRepositoryUnits(input: {
  orgId: string
  workspaceId: string
  projectionSha: string
  paths: string[]
}): Promise<RepositoryUnits> {
  const empty = { kinds: {}, units: 0, withoutEmbedding: 0, presentPaths: [] }
  if (input.paths.length === 0) return empty
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({
        path: workspaceKnowledgeUnits.path,
        kind: workspaceKnowledgeUnits.kind,
        embedded: sql<boolean>`${workspaceKnowledgeUnits.embedding} is not null`,
      })
      .from(workspaceKnowledgeUnits)
      .where(
        and(
          eq(workspaceKnowledgeUnits.orgId, input.orgId),
          eq(workspaceKnowledgeUnits.workspaceId, input.workspaceId),
          eq(workspaceKnowledgeUnits.projectionSha, input.projectionSha),
          inArray(workspaceKnowledgeUnits.path, input.paths),
        ),
      ),
  )
  const kinds: Record<string, number> = {}
  for (const row of rows) {
    const kind = row.kind ?? "(none)"
    kinds[kind] = (kinds[kind] ?? 0) + 1
  }
  return {
    kinds,
    units: rows.length,
    withoutEmbedding: rows.filter((row) => !row.embedded).length,
    presentPaths: rows.map((row) => row.path).sort(),
  }
}

/** SHA whose units the Workspace serves (the same rule as the projection snapshot). */
export async function readActiveProjectionSha(
  orgId: string,
  workspaceId: string,
): Promise<string | null> {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({
        sha: sql<
          string | null
        >`coalesce(${workspaces.activeRevision}->>'sha', ${workspaces.activeProjectionSha})`,
      })
      .from(workspaces)
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, workspaceId))),
  )
  return row?.sha ?? null
}
