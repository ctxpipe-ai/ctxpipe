/**
 * Postgres reads for the ingestion validator: the native OpenWorkflow run
 * trees of one repository's ingestions, the repository row, in-flight and
 * follow-up ingestions, and the extraction-destination guard.
 */
import { and, eq, sql } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../db/schema/repositories.js"
import { workspaces } from "../db/schema/workspaces.js"

export type ValidatorRun = {
  id: string
  /** The root run whose tree this run belongs to. */
  rootRunId: string
  workflowName: string
  status: string
  parentRunId: string | null
  parentStepName: string | null
  /** Run output without per-path change lists (they can hold every file of a repository). */
  output: unknown
  error: unknown
  /** `request.id` of the job telemetry the run was admitted with. */
  requestId: string | null
  /** `workspaceId` of the run input (the captured extraction destination for extract runs). */
  workspaceId: string | null
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
  /** Kept only for the codesearch steps the checks read. */
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
        select run.id, run.id as root_run_id, null::text as parent_run_id,
          null::text as parent_step_name, 0 as depth
        from openworkflow.workflow_runs run
        where run.namespace_id = ${namespaceId} and run.id in (${roots})
        union all
        select child.id, tree.root_run_id, attempt.workflow_run_id, attempt.step_name, tree.depth + 1
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
        run.id, tree.root_run_id, run.workflow_name, run.status, tree.parent_run_id,
        tree.parent_step_name,
        case when jsonb_typeof(run.output) = 'object'
          then run.output - 'changedPaths' - 'deletedPaths' - 'renames'
          else run.output end as output,
        run.error,
        run.input->'telemetry'->>'request.id' as request_id,
        run.input->>'workspaceId' as workspace_id,
        case when run.workflow_name = 'workspace-hydrate'
          then run.input->'revision'->>'sha' end as revision_sha,
        run.context->'traceContext'->>'traceparent' as traceparent,
        run.created_at, run.started_at, run.finished_at
      from tree
      join openworkflow.workflow_runs run on run.namespace_id = ${namespaceId} and run.id = tree.id
      order by run.id, tree.depth
    `)
    const text = (value: unknown) => (value as string | null) ?? null
    const runs: ValidatorRun[] = runRows.rows.map((row) => ({
      id: String(row.id),
      rootRunId: String(row.root_run_id),
      workflowName: String(row.workflow_name),
      status: String(row.status),
      parentRunId: text(row.parent_run_id),
      parentStepName: text(row.parent_step_name),
      output: row.output ?? null,
      error: row.error ?? null,
      requestId: text(row.request_id),
      workspaceId: text(row.workspace_id),
      revisionSha: text(row.revision_sha),
      traceId: traceIdFromTraceparent(text(row.traceparent)),
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
        case when step_name ~ '^(zoekt|detect-languages|scip:|merge-scip)'
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
      childRunId: text(row.child_workflow_run_id),
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

/**
 * Orchestrator runs of this repository admitted with the validator's request
 * id since it started: its own enqueue and every tip-ahead follow-up, oldest first.
 */
export async function findAttributedIngestions(input: {
  orgId: string
  namespaceId: string
  repositoryId: string
  requestId: string
}): Promise<string[]> {
  return withOrgDbContext(input.orgId, async (db) => {
    const result = await db.execute<{ id: string }>(sql`
      select id from openworkflow.workflow_runs
      where namespace_id = ${input.namespaceId}
        and workflow_name = 'repository-ingestion-orchestrator'
        and input->>'orgId' = ${input.orgId}
        and input->>'repositoryId' = ${input.repositoryId}
        and input->'telemetry'->>'request.id' = ${input.requestId}
      order by created_at
    `)
    return result.rows.map((row) => row.id)
  })
}

/** The repository's current ingestion owner while it is still pending, running or sleeping. */
export async function findInFlightIngestion(input: {
  orgId: string
  namespaceId: string
  repositoryId: string
}): Promise<{ id: string; requestId: string | null } | null> {
  return withOrgDbContext(input.orgId, async (db) => {
    const result = await db.execute<{ id: string; requestId: string | null }>(
      sql`
      select owner.id, owner.input->'telemetry'->>'request.id' as "requestId"
      from ${repositoryIngestionRequests} request
      join openworkflow.workflow_runs owner
        on owner.namespace_id = ${input.namespaceId} and owner.id = request.workflow_run_id
      where request.repository_id = ${input.repositoryId} and request.org_id = ${input.orgId}
        and owner.status in ('pending', 'running', 'sleeping')
    `,
    )
    return result.rows[0] ?? null
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

/**
 * Throw unless extraction can reach only where the mode allows: nowhere in
 * index-only mode (the org has no Workspace, so ingestion stops after
 * codesearch and makes no LLM call), and only `workspaceId` in full mode
 * (the org's sole Workspace, so it is also the org's first one).
 */
export async function assertExtractionDestination(input: {
  orgId: string
  mode: "index-only" | "full"
  workspaceId: string | null
}): Promise<void> {
  const rows = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.orgId, input.orgId)),
  )
  const ids = rows.map((row) => row.id)
  if (input.mode === "index-only" && ids.length > 0)
    throw new Error(
      `index-only refuses an org with a Workspace (${ids.length}); extraction would run and spend`,
    )
  if (
    input.mode === "full" &&
    (ids.length !== 1 || ids[0] !== input.workspaceId)
  )
    throw new Error(
      `full mode needs ${input.workspaceId} to be the org's only Workspace; found ${ids.length}`,
    )
}
