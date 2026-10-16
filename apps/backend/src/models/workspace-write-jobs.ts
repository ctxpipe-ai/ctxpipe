import { isDeepStrictEqual } from "node:util"
import { and, eq, inArray, lt, ne, type SQL, sql } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import {
  workspaceKnowledgePathState,
  workspaces,
  workspaceWriteJobs,
} from "../db/schema/workspaces.js"
import type { UnbornBootstrapBinding } from "../domain/workspaces/bootstrap-input.js"
import type { ConnectorMirrorSource } from "../domain/workspaces/connector-mirror.js"
import type { WorkspaceExtraction } from "../domain/workspaces/extraction.js"
import type { IngestPublishSource } from "../domain/workspaces/extraction-source.js"
import {
  sameWorkspaceRevision,
  type WorkspaceRevision,
} from "../domain/workspaces/revision.js"
import {
  type WorkspaceWriteJobPayload,
  WRITE_JOB_STATUSES,
} from "../domain/workspaces/write-job-intent.js"
import type { WorkspaceWriteJobKind } from "../domain/workspaces/write-jobs.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import type { GitFileChange } from "../services/git/file-change.js"
import { orgSql } from "./workspace-sql.js"

export async function getWriteJobCommitSha(
  jobId: string,
): Promise<string | null> {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .select({ commitSha: workspaceWriteJobs.commitSha })
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.completed),
        ),
      )
      .limit(1)
    return row?.commitSha ?? null
  })
}

/** Set the status of a job. `failureReason` records why a job failed. */
export async function persistWriteJobStatus(
  jobId: string,
  status: string,
  failureReason?: string,
): Promise<void> {
  await orgSql(async () => {
    const [row] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        status,
        updatedAt: new Date(),
        ...(failureReason
          ? {
              payload: sql`jsonb_set(coalesce(${workspaceWriteJobs.payload}, '{}'::jsonb), '{failureReason}', to_jsonb(${failureReason}::text))`,
            }
          : {}),
      })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          ne(workspaceWriteJobs.status, WRITE_JOB_STATUSES.completed),
        ),
      )
      .returning()
    if (row?.status === WRITE_JOB_STATUSES.completed)
      await projectCompletedKnowledgePaths(row)
  })
}

export async function listPausedWriteJobs(workspaceId: string): Promise<
  Array<{
    id: string
    kind: WorkspaceWriteJobKind
    generation: number
    desiredSha: string | null
    status: string
    payload: WorkspaceWriteJobPayload | null
  }>
> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({
        id: workspaceWriteJobs.id,
        kind: workspaceWriteJobs.kind,
        generation: workspaceWriteJobs.generation,
        desiredSha: workspaceWriteJobs.desiredSha,
        status: workspaceWriteJobs.status,
        payload: workspaceWriteJobs.payload,
      })
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.workspaceId, workspaceId),
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.paused),
          // A paused direct export from before upgrade step 1 never
          // resumes: the export goes only through the upgrade pull request
          // (ADR-053).
          ne(workspaceWriteJobs.kind, "migration_export"),
        ),
      )
    return rows.map((row) => ({
      ...row,
      kind: row.kind as WorkspaceWriteJobKind,
    }))
  })
}

export async function claimPausedWriteJob(jobId: string): Promise<boolean> {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({ status: WRITE_JOB_STATUSES.queued, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.paused),
          sql`${workspaceWriteJobs.payload}->>'workflowRunId' is null`,
        ),
      )
      .returning({ id: workspaceWriteJobs.id })
    return row != null
  })
}

export async function persistWriteJobCommitSha(
  jobId: string,
  commitSha: string | null,
): Promise<void> {
  await orgSql(async () => {
    const [row] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        commitSha,
        status: WRITE_JOB_STATUSES.completed,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          ne(workspaceWriteJobs.status, WRITE_JOB_STATUSES.completed),
        ),
      )
      .returning()
    if (row) await projectCompletedKnowledgePaths(row)
  })
}

/** Bind the exact native delta to the existing command before admitting its child. */
export async function persistSemanticHandoff(input: {
  jobId: string
  revision: WorkspaceRevision
  nextRevision: WorkspaceRevision
  candidateSha: string
  files: GitFileChange[]
  deletePaths: string[]
  mirror?: ConnectorMirrorSource
  extraction?: WorkspaceExtraction
}) {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, input.jobId))
      .for("update")
    if (
      !row ||
      row.status !== "running" ||
      !row.payload?.workflowRunId ||
      !sameWorkspaceRevision(row.payload.revision, input.revision) ||
      !isDeepStrictEqual(row.payload.mirror, input.mirror) ||
      !isDeepStrictEqual(row.payload.extraction, input.extraction) ||
      row.commitSha !== input.candidateSha
    )
      throw new Error(
        "Semantic handoff requires the owning unpublished command",
      )
    const handoff = {
      ownerRunId: row.payload.workflowRunId,
      candidateSha: input.candidateSha,
      revision: input.nextRevision,
      files: input.files,
      deletePaths: input.deletePaths,
    }
    const existing = row.payload.semanticHandoff
    if (existing) {
      if (
        existing.ownerRunId !== handoff.ownerRunId ||
        existing.candidateSha !== handoff.candidateSha ||
        !isDeepStrictEqual(existing.files, handoff.files) ||
        !isDeepStrictEqual(existing.deletePaths, handoff.deletePaths)
      )
        throw new Error("Write job already has a different semantic handoff")
      // A committed handoff survives loss of this SQL reply. The semantic child
      // owns reconciliation if the remote advances again before step replay.
      return existing
    }
    await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        payload: { ...row.payload, semanticHandoff: handoff },
        updatedAt: new Date(),
      })
      .where(eq(workspaceWriteJobs.id, input.jobId))
    return handoff
  })
}

/** Native semantic children share their parent's immutable command and result row. */
export async function validateSemanticHandoff(
  input: {
    jobId: string
    workspaceId: string
    revision: WorkspaceRevision
    previousSha: string
    files: GitFileChange[]
    deletePaths: string[]
    mirror?: ConnectorMirrorSource
    extraction?: WorkspaceExtraction
    handoff: { ownerRunId: string; candidateSha: string }
  },
  preparedSha?: string,
) {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, input.jobId))
      .for("update")
    if (
      !row ||
      row.workspaceId !== input.workspaceId ||
      row.payload?.workflowRunId !== input.handoff.ownerRunId ||
      row.payload?.revision?.sha !== input.previousSha ||
      !isDeepStrictEqual(row.payload?.mirror, input.mirror) ||
      !isDeepStrictEqual(row.payload?.extraction, input.extraction) ||
      !isDeepStrictEqual(row.payload?.semanticHandoff, {
        ...input.handoff,
        revision: input.revision,
        files: input.files,
        deletePaths: input.deletePaths,
      })
    )
      throw new Error("Semantic child does not match the admitted handoff")
    if (row.status === "completed")
      return row.commitSha
        ? { committed: true as const, commitSha: row.commitSha }
        : { committed: false as const, reason: "no_changes" as const }
    if (row.status !== "running" && row.status !== "paused")
      throw new Error("Semantic parent is not active")
    if (preparedSha) {
      if (
        row.commitSha !== null &&
        row.commitSha !== input.handoff.candidateSha &&
        row.commitSha !== preparedSha
      )
        throw new Error("Semantic handoff already has a different candidate")
      await getOrgDb()
        .update(workspaceWriteJobs)
        .set({ commitSha: preparedSha, updatedAt: new Date() })
        .where(eq(workspaceWriteJobs.id, input.jobId))
    }
    return null
  })
}

/** Record the immutable candidate before remote I/O, without claiming publication. */
export async function persistWriteJobPreparedCommit(
  jobId: string,
  commitSha: string,
): Promise<void> {
  await orgSql(async () => {
    const [row] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({ commitSha, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          ne(workspaceWriteJobs.status, WRITE_JOB_STATUSES.completed),
          sql`(${workspaceWriteJobs.commitSha} is null or ${workspaceWriteJobs.commitSha} = ${commitSha})`,
        ),
      )
      .returning({ id: workspaceWriteJobs.id })
    if (!row)
      throw new Error(
        "Write job already has a different commit or no longer exists",
      )
  })
}

/** Only a durably rejected push may release its exact unpublished candidate. */
export async function discardWriteJobPreparedCommit(
  jobId: string,
  candidateSha: string,
): Promise<void> {
  await orgSql(async () => {
    const [row] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({ commitSha: null, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.running),
          sql`(${workspaceWriteJobs.commitSha} = ${candidateSha} or ${workspaceWriteJobs.commitSha} is null)`,
        ),
      )
      .returning({ id: workspaceWriteJobs.id })
    if (!row)
      throw new Error("Unpublished candidate changed before semantic retry")
  })
}

/** Resolve only this command's accepted native owner, including a lost admission reply. */
function nativeWriteJobOwnerId() {
  const namespaceId = openWorkflowNamespaceId()
  return sql<
    string | null
  >`(select scheduled.id from openworkflow.workflow_runs scheduled
    where scheduled.input->>'orgId' = workspace_write_jobs.org_id
      and scheduled.input->>'workspaceId' = workspace_write_jobs.workspace_id
      and scheduled.input->>'jobId' = workspace_write_jobs.id
      and scheduled.workflow_name = 'workspace-write-' || replace(workspace_write_jobs.kind, '_', '-')
      and scheduled.version is null
      and scheduled.namespace_id = ${namespaceId}
      and (scheduled.id = workspace_write_jobs.payload->>'workflowRunId'
        or (workspace_write_jobs.payload->>'workflowRunId' is null
          and scheduled.idempotency_key = workspace_write_jobs.id
          and (scheduled.input->'revision' = workspace_write_jobs.payload->'revision'
            or (workspace_write_jobs.kind = 'bootstrap' and scheduled.input->'bootstrapBinding' = workspace_write_jobs.payload->'bootstrapBinding'))))
    order by scheduled.created_at, scheduled.id limit 1)`
}

/** Set `failed` on a job whose owning run is terminal. */
function failJobsWithEndedRun(...conditions: SQL[]) {
  // OpenWorkflow is the retry authority. Reconcile only a terminal owning run;
  // a failed step whose native retries are still pending must remain running.
  return getOrgDb()
    .update(workspaceWriteJobs)
    .set({
      status: WRITE_JOB_STATUSES.failed,
      payload: sql`jsonb_set(${workspaceWriteJobs.payload}, '{workflowRunId}', to_jsonb(${nativeWriteJobOwnerId()}::text))`,
      updatedAt: new Date(),
    })
    .where(
      and(
        ...conditions,
        sql`exists (select 1 from openworkflow.workflow_runs owner
        where owner.id = ${nativeWriteJobOwnerId()}
          and owner.input->>'orgId' = ${workspaceWriteJobs.orgId}
          and owner.input->>'workspaceId' = ${workspaceWriteJobs.workspaceId}
          and owner.input->>'jobId' = ${workspaceWriteJobs.id}
          and owner.status in ('failed', 'canceled'))`,
      ),
    )
}

export async function reconcileWorkspaceWriteJob(jobId: string) {
  return orgSql(async () => {
    await failJobsWithEndedRun(
      eq(workspaceWriteJobs.id, jobId),
      inArray(workspaceWriteJobs.status, [
        WRITE_JOB_STATUSES.queued,
        WRITE_JOB_STATUSES.running,
        WRITE_JOB_STATUSES.paused,
      ]),
    )
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, jobId))
      .limit(1)
    return row ?? null
  })
}

/**
 * Reconcile the jobs of a Workspace that stayed `queued` or `running` since
 * before `staleBefore`. A job whose run failed or was canceled becomes
 * `failed`. A `queued` job that has no run lost its run, for example because
 * the process stopped after it stored the job and before it queued the run.
 * Such a job becomes `paused`, so that the resume step queues it again with
 * the same id. When it binds an earlier generation, another repository URL
 * or another default branch, a newer binding supersedes it, so it becomes
 * `failed`. Admission refuses such a job, so a retry cannot succeed.
 */
export async function reconcileStaleWriteJobs(
  workspace: {
    id: string
    desiredGeneration: number
    workspaceRepositoryUrl: string
    desiredDefaultBranch?: string | null
  },
  staleBefore: Date,
) {
  return orgSql(async () => {
    const stale = [
      eq(workspaceWriteJobs.workspaceId, workspace.id),
      lt(workspaceWriteJobs.updatedAt, staleBefore),
    ]
    await failJobsWithEndedRun(
      ...stale,
      inArray(workspaceWriteJobs.status, [
        WRITE_JOB_STATUSES.queued,
        WRITE_JOB_STATUSES.running,
      ]),
    )
    const sameBinding = sql<boolean>`(${workspaceWriteJobs.generation} = ${workspace.desiredGeneration}
      and coalesce(${workspaceWriteJobs.payload}->>'jobWorkspaceUrl', ${workspace.workspaceRepositoryUrl}) = ${workspace.workspaceRepositoryUrl}
      and coalesce(${workspaceWriteJobs.payload}->>'defaultBranch', ${workspaceWriteJobs.payload}->'revision'->>'defaultBranch', ${workspace.desiredDefaultBranch ?? null}) is not distinct from ${workspace.desiredDefaultBranch ?? null})`
    await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        status: sql`case when ${sameBinding} then ${WRITE_JOB_STATUSES.paused} else ${WRITE_JOB_STATUSES.failed} end`,
        payload: sql`case when ${sameBinding} then ${workspaceWriteJobs.payload}
          else jsonb_set(coalesce(${workspaceWriteJobs.payload}, '{}'::jsonb), '{failureReason}', to_jsonb('superseded'::text)) end`,
        updatedAt: new Date(),
      })
      .where(
        and(
          ...stale,
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.queued),
          sql`${workspaceWriteJobs.payload}->>'workflowRunId' is null`,
          sql`${nativeWriteJobOwnerId()} is null`,
        ),
      )
  })
}

/** Immutable command admission and atomic ownership by one native workflow run. */
export async function persistBoundWriteJob(input: {
  id: string
  kind: WorkspaceWriteJobKind
  revision: WorkspaceRevision
  files?: GitFileChange[]
  deletePaths?: string[]
  workflowRunId?: string
  admissionStatus?: "queued" | "paused"
  /** Stored for a later resume; not part of the command identity. */
  publishPipeline?: "legacy" | "v2"
  /** The source repository that an `unlink_retraction` job retracts. */
  retractRepositoryUrl?: string
  /** The removed source file of that repository (ADR-050, 2026-10-16). */
  retractSourcePath?: string
  displayName?: string
  previousSha?: string
  extraction?: WorkspaceExtraction
  ingest?: IngestPublishSource
  mirror?: ConnectorMirrorSource
}) {
  return orgSql(async () => {
    const payload: WorkspaceWriteJobPayload = {
      revision: input.revision,
      ...(input.extraction ? { extraction: input.extraction } : {}),
      ...(input.ingest ? { ingest: input.ingest } : {}),
      ...(input.mirror ? { mirror: input.mirror } : {}),
      ...(input.previousSha ? { previousSha: input.previousSha } : {}),
      ...(input.displayName !== undefined
        ? { displayName: input.displayName }
        : {}),
      ...(input.files ? { mergeFiles: input.files } : {}),
      ...(input.deletePaths ? { mergeDeletePaths: input.deletePaths } : {}),
      ...(input.publishPipeline
        ? { publishPipeline: input.publishPipeline }
        : {}),
      ...(input.retractRepositoryUrl
        ? { retractRepositoryUrl: input.retractRepositoryUrl }
        : {}),
      ...(input.retractSourcePath
        ? { retractSourcePath: input.retractSourcePath }
        : {}),
      jobWorkspaceUrl: input.revision.remote.url,
      defaultBranch: input.revision.defaultBranch,
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    }
    const values = {
      id: input.id,
      orgId: requireCurrentOrgId(),
      workspaceId: input.revision.workspaceId,
      kind: input.kind,
      generation: input.revision.generation,
      desiredSha: input.revision.sha,
      status: input.workflowRunId
        ? "running"
        : (input.admissionStatus ?? "queued"),
      payload,
    }
    await getOrgDb()
      .insert(workspaceWriteJobs)
      .values(values)
      .onConflictDoNothing()
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, input.id))
      .limit(1)
    if (
      !row ||
      row.workspaceId !== input.revision.workspaceId ||
      row.kind !== input.kind ||
      row.generation !== input.revision.generation ||
      row.payload?.jobWorkspaceUrl !== input.revision.remote.url
    )
      throw new Error("Write job id belongs to a different command")
    if (
      row.payload?.revision &&
      !sameWorkspaceRevision(row.payload.revision, input.revision)
    )
      throw new Error("Write job id belongs to a different revision")
    if (
      !isDeepStrictEqual(row.payload?.mergeFiles, input.files) ||
      !isDeepStrictEqual(row.payload?.mergeDeletePaths, input.deletePaths) ||
      !isDeepStrictEqual(row.payload?.mirror, input.mirror) ||
      !isDeepStrictEqual(row.payload?.extraction, input.extraction) ||
      !isDeepStrictEqual(row.payload?.ingest, input.ingest) ||
      row.payload?.previousSha !== input.previousSha ||
      row.payload?.displayName !== input.displayName ||
      row.payload?.retractRepositoryUrl !== input.retractRepositoryUrl ||
      row.payload?.retractSourcePath !== input.retractSourcePath
    )
      throw new Error("Write job id belongs to a different file command")
    if (!input.workflowRunId && row.payload?.revision) {
      if (
        !row.payload.workflowRunId &&
        (row.status === WRITE_JOB_STATUSES.failed ||
          row.status === WRITE_JOB_STATUSES.paused)
      ) {
        await getOrgDb()
          .update(workspaceWriteJobs)
          .set({
            status: input.admissionStatus ?? WRITE_JOB_STATUSES.queued,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workspaceWriteJobs.id, input.id),
              sql`${workspaceWriteJobs.status} in ('failed', 'paused')`,
              sql`${workspaceWriteJobs.payload}->>'workflowRunId' is null`,
            ),
          )
      }
      return
    }
    if (row.payload?.planning) payload.planning = row.payload.planning
    if (row.payload?.bootstrapBinding)
      payload.bootstrapBinding = row.payload.bootstrapBinding
    const [claimed] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({ payload, status: values.status, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceWriteJobs.id, input.id),
          sql`${workspaceWriteJobs.commitSha} is null`,
          sql`(${workspaceWriteJobs.payload}->>'workflowRunId' is null or ${workspaceWriteJobs.payload}->>'workflowRunId' = ${input.workflowRunId ?? null})`,
          sql`(${workspaceWriteJobs.payload}->'revision' = ${JSON.stringify(input.revision)}::jsonb or (${workspaceWriteJobs.status} in ('paused', 'queued') and ${workspaceWriteJobs.payload}->'revision' is null))`,
        ),
      )
      .returning({ id: workspaceWriteJobs.id })
    if (!claimed) throw new Error("Write job already has a workflow owner")
  })
}

/** Recover accepted native admission before reporting an enqueue failure. */
export async function reconcileWriteJobAdmission(
  jobId: string,
): Promise<boolean> {
  return orgSql(async () => {
    const db = getOrgDb()
    const [row] = await db
      .select({ ownerId: nativeWriteJobOwnerId() })
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, jobId))
      .for("update")
      .limit(1)
    if (row?.ownerId) {
      await db
        .update(workspaceWriteJobs)
        .set({
          payload: sql`jsonb_set(${workspaceWriteJobs.payload}, '{workflowRunId}', to_jsonb(${row.ownerId}::text))`,
        })
        .where(eq(workspaceWriteJobs.id, jobId))
      return true
    }
    await db
      .update(workspaceWriteJobs)
      .set({ status: WRITE_JOB_STATUSES.failed, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          inArray(workspaceWriteJobs.status, [
            WRITE_JOB_STATUSES.queued,
            WRITE_JOB_STATUSES.paused,
          ]),
          sql`${workspaceWriteJobs.payload}->>'workflowRunId' is null`,
          sql`${nativeWriteJobOwnerId()} is null`,
        ),
      )
    return false
  })
}

function matchingPathBinding(
  stored: WorkspaceRevision,
  revision: WorkspaceRevision,
): boolean {
  return sameWorkspaceRevision(
    { ...stored, sha: revision.sha, access: revision.access },
    revision,
  )
}

/** Publish result metadata in the same short transaction as command completion. */
async function projectCompletedKnowledgePaths(
  row: typeof workspaceWriteJobs.$inferSelect,
): Promise<void> {
  const revision = row.payload?.revision
  const paths = row.payload?.knowledgePaths
  if (!revision || !paths) return
  const db = getOrgDb()
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, row.workspaceId))
    .for("update")
  if (
    !workspace ||
    workspace.desiredGeneration !== revision.generation ||
    workspace.workspaceRepositoryUrl !== revision.remote.url ||
    workspace.githubConnectionId !== revision.remote.connectionId ||
    workspace.desiredDefaultBranch !== revision.defaultBranch
  )
    return
  const [previous] = await db
    .select()
    .from(workspaceKnowledgePathState)
    .where(eq(workspaceKnowledgePathState.workspaceId, row.workspaceId))
    .limit(1)
  const state = {
    revision,
    paths: {
      ...(previous && matchingPathBinding(previous.revision, revision)
        ? previous.paths
        : {}),
      ...paths,
    },
  }
  await db
    .insert(workspaceKnowledgePathState)
    .values({ workspaceId: row.workspaceId, orgId: row.orgId, ...state })
    .onConflictDoUpdate({
      target: workspaceKnowledgePathState.workspaceId,
      set: state,
    })
}

/** Read one current binding's compact completed-result metadata, independent of job history. */
export async function getCompletedKnowledgePaths(
  revision: WorkspaceRevision,
): Promise<Record<string, string>> {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .select()
      .from(workspaceKnowledgePathState)
      .where(eq(workspaceKnowledgePathState.workspaceId, revision.workspaceId))
      .limit(1)
    return row && matchingPathBinding(row.revision, revision) ? row.paths : {}
  })
}

export async function persistWriteJobKnowledgePaths(
  jobId: string,
  paths: Record<string, string>,
): Promise<void> {
  await orgSql(async () => {
    const [row] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        payload: sql`coalesce(${workspaceWriteJobs.payload}, '{}'::jsonb) || jsonb_build_object('knowledgePaths', ${JSON.stringify(paths)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.running),
        ),
      )
      .returning({ id: workspaceWriteJobs.id })
    if (!row)
      throw new Error(
        "Knowledge path assignments require a running write command",
      )
  })
}

/** Claim the same typed bootstrap before a read revision exists. */
export async function persistUnbornBootstrapJob(input: {
  id: string
  binding: UnbornBootstrapBinding
  workflowRunId?: string
  admissionStatus?: "queued" | "paused"
}) {
  return orgSql(async () => {
    const payload: WorkspaceWriteJobPayload = {
      bootstrapBinding: input.binding,
      jobWorkspaceUrl: input.binding.remote.url,
      defaultBranch: input.binding.defaultBranch,
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    }
    await getOrgDb()
      .insert(workspaceWriteJobs)
      .values({
        id: input.id,
        orgId: requireCurrentOrgId(),
        workspaceId: input.binding.workspaceId,
        kind: "bootstrap",
        generation: input.binding.generation,
        desiredSha: null,
        status: input.workflowRunId
          ? "running"
          : (input.admissionStatus ?? "queued"),
        payload,
      })
      .onConflictDoNothing()
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, input.id))
      .for("update")
    if (
      !row ||
      row.kind !== "bootstrap" ||
      row.workspaceId !== input.binding.workspaceId ||
      row.generation !== input.binding.generation ||
      !isDeepStrictEqual(row.payload?.bootstrapBinding, input.binding)
    )
      throw new Error("Bootstrap id belongs to a different command")
    if (row.status === "completed") return row
    if (
      input.workflowRunId &&
      row.payload?.workflowRunId &&
      row.payload.workflowRunId !== input.workflowRunId
    )
      throw new Error("Bootstrap already has a workflow owner")
    if (!input.workflowRunId && row.payload?.workflowRunId) return row
    const [updated] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        payload: { ...row.payload, ...payload },
        status: input.workflowRunId
          ? "running"
          : (input.admissionStatus ?? "queued"),
        updatedAt: new Date(),
      })
      .where(eq(workspaceWriteJobs.id, input.id))
      .returning()
    if (!updated) throw new Error("Bootstrap command disappeared")
    return updated
  })
}

/** A competing first writer supplies a real base for the same bootstrap owner. */
export async function adoptInitializedBootstrapRevision(input: {
  jobId: string
  workflowRunId: string
  binding: UnbornBootstrapBinding
  revision: WorkspaceRevision
  candidateSha: string
}): Promise<void> {
  await orgSql(async () => {
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, input.jobId))
      .for("update")
    if (
      !row ||
      row.kind !== "bootstrap" ||
      row.status !== "running" ||
      row.payload?.workflowRunId !== input.workflowRunId ||
      !isDeepStrictEqual(row.payload.bootstrapBinding, input.binding)
    )
      throw new Error("Initialized bootstrap has a different owner")
    if (row.payload.revision) {
      if (!sameWorkspaceRevision(row.payload.revision, input.revision))
        throw new Error("Bootstrap already adopted another revision")
      return
    }
    if (
      row.commitSha !== input.candidateSha ||
      input.revision.workspaceId !== input.binding.workspaceId ||
      input.revision.generation !== input.binding.generation ||
      input.revision.remote.url !== input.binding.remote.url ||
      input.revision.remote.connectionId !==
        input.binding.remote.connectionId ||
      input.revision.defaultBranch !== input.binding.defaultBranch ||
      input.revision.access !== "write-default"
    )
      throw new Error("Initialized bootstrap binding changed")
    await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        payload: { ...row.payload, revision: input.revision },
        desiredSha: input.revision.sha,
        commitSha: null,
        updatedAt: new Date(),
      })
      .where(eq(workspaceWriteJobs.id, input.jobId))
  })
}
