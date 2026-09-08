import { isDeepStrictEqual } from "node:util"
import { and, asc, eq, isNotNull, notInArray, sql } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { workspaces, workspaceWriteJobs } from "../db/schema/workspaces.js"
import {
  sameWorkspaceRevision,
  type WorkspaceRevision,
} from "../domain/workspaces/revision.js"
import type { WorkspaceWriteKind } from "../domain/workspaces/write-commit-files.js"
import {
  type WorkspaceWriteJobPayload,
  WRITE_JOB_STATUSES,
} from "../domain/workspaces/write-job-intent.js"
import { orgSql } from "./workspace-sql.js"

export async function persistLastJobAt(workspaceId: string): Promise<void> {
  await orgSql(async () => {
    await getOrgDb()
      .update(workspaces)
      .set({ lastJobAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
  })
}

export async function getWriteJobCommitSha(
  jobId: string,
): Promise<string | null> {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .select({ commitSha: workspaceWriteJobs.commitSha })
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, jobId))
      .limit(1)
    return row?.commitSha ?? null
  })
}

export async function persistWriteJobIntent(input: {
  id: string
  workspaceId: string
  kind: string
  generation: number
  desiredSha?: string | null
  status: string
  payload: WorkspaceWriteJobPayload
}): Promise<void> {
  const now = new Date()
  await orgSql(async () => {
    await getOrgDb()
      .insert(workspaceWriteJobs)
      .values({
        id: input.id,
        orgId: requireCurrentOrgId(),
        workspaceId: input.workspaceId,
        kind: input.kind,
        generation: input.generation,
        desiredSha: input.desiredSha ?? null,
        status: input.status,
        payload: input.payload,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workspaceWriteJobs.id,
        set: {
          kind: input.kind,
          generation: input.generation,
          desiredSha: input.desiredSha ?? null,
          status: input.status,
          payload: input.payload,
          updatedAt: now,
        },
        setWhere: sql`${workspaceWriteJobs.commitSha} is null`,
      })
  })
}

export async function persistWriteJobStart(input: {
  id: string
  workspaceId: string
  kind: string
  generation: number
  desiredSha?: string | null
  payload?: WorkspaceWriteJobPayload
}): Promise<void> {
  const now = new Date()
  await orgSql(async () => {
    await getOrgDb()
      .insert(workspaceWriteJobs)
      .values({
        id: input.id,
        orgId: requireCurrentOrgId(),
        workspaceId: input.workspaceId,
        kind: input.kind,
        generation: input.generation,
        desiredSha: input.desiredSha ?? null,
        status: WRITE_JOB_STATUSES.running,
        payload: input.payload ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workspaceWriteJobs.id,
        set: {
          status: WRITE_JOB_STATUSES.running,
          ...(input.payload ? { payload: input.payload } : {}),
          desiredSha: input.desiredSha ?? null,
          updatedAt: now,
        },
        setWhere: sql`${workspaceWriteJobs.commitSha} is null`,
      })
  })
}

export async function persistWriteJobStatus(
  jobId: string,
  status: string,
): Promise<void> {
  await orgSql(async () => {
    await getOrgDb()
      .update(workspaceWriteJobs)
      .set({ status, updatedAt: new Date() })
      .where(eq(workspaceWriteJobs.id, jobId))
  })
}

export async function listPausedWriteJobs(workspaceId: string): Promise<
  Array<{
    id: string
    kind: WorkspaceWriteKind
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
        ),
      )
    return rows.map((row) => ({
      ...row,
      kind: row.kind as WorkspaceWriteKind,
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
        ),
      )
      .returning({ id: workspaceWriteJobs.id })
    return row != null
  })
}

export async function countWriteJobAttempts(input: {
  workspaceId: string
  kind: string
  desiredSha: string
}): Promise<number> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({ id: workspaceWriteJobs.id })
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.workspaceId, input.workspaceId),
          eq(workspaceWriteJobs.kind, input.kind),
          eq(workspaceWriteJobs.desiredSha, input.desiredSha),
          notInArray(workspaceWriteJobs.status, [
            WRITE_JOB_STATUSES.paused,
            WRITE_JOB_STATUSES.queued,
          ]),
        ),
      )
    return rows.length
  })
}

export async function persistWriteJobCommitSha(
  jobId: string,
  commitSha: string,
): Promise<void> {
  return orgSql(async () => {
    await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        commitSha,
        status: WRITE_JOB_STATUSES.completed,
        updatedAt: new Date(),
      })
      .where(eq(workspaceWriteJobs.id, jobId))
  })
}

export async function listMigrationExportJobWorkspaceIds(): Promise<
  Set<string>
> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({ workspaceId: workspaceWriteJobs.workspaceId })
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.kind, "migration_export"))
    return new Set(rows.map((row) => row.workspaceId))
  })
}

export async function listMigrationExportShas(): Promise<Map<string, string>> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({
        workspaceId: workspaceWriteJobs.workspaceId,
        commitSha: workspaceWriteJobs.commitSha,
      })
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.kind, "migration_export"),
          isNotNull(workspaceWriteJobs.commitSha),
        ),
      )
      .orderBy(asc(workspaceWriteJobs.createdAt))
    const shas = new Map<string, string>()
    for (const row of rows) {
      if (row.commitSha && !shas.has(row.workspaceId)) {
        shas.set(row.workspaceId, row.commitSha)
      }
    }
    return shas
  })
}

export async function getMigrationExportSha(
  workspaceId: string,
): Promise<string | null> {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .select({ commitSha: workspaceWriteJobs.commitSha })
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.workspaceId, workspaceId),
          eq(workspaceWriteJobs.kind, "migration_export"),
          isNotNull(workspaceWriteJobs.commitSha),
        ),
      )
      .orderBy(asc(workspaceWriteJobs.createdAt))
      .limit(1)
    return row?.commitSha ?? null
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

export async function reconcileWorkspaceWriteJob(jobId: string) {
  return orgSql(async () => {
    // OpenWorkflow is the retry authority. Reconcile only a terminal owning run;
    // a failed step whose native retries are still pending must remain running.
    await getOrgDb()
      .update(workspaceWriteJobs)
      .set({ status: WRITE_JOB_STATUSES.failed, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.running),
          sql`exists (select 1 from openworkflow.workflow_runs owner
        where owner.id::text = ${workspaceWriteJobs.payload}->>'workflowRunId'
          and owner.input->>'orgId' = ${workspaceWriteJobs.orgId}
          and owner.input->>'workspaceId' = ${workspaceWriteJobs.workspaceId}
          and owner.input->>'jobId' = ${workspaceWriteJobs.id}
          and owner.status in ('failed', 'canceled'))`,
        ),
      )
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, jobId))
      .limit(1)
    return row ?? null
  })
}

/** Immutable command admission and atomic ownership by one native workflow run. */
export async function persistBoundWriteJob(input: {
  id: string
  kind: WorkspaceWriteKind
  revision: WorkspaceRevision
  files?: Array<{ path: string; content: string }>
  deletePaths?: string[]
  workflowRunId?: string
}) {
  return orgSql(async () => {
    const payload: WorkspaceWriteJobPayload = {
      revision: input.revision,
      ...(input.files ? { mergeFiles: input.files } : {}),
      ...(input.deletePaths ? { mergeDeletePaths: input.deletePaths } : {}),
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
      status: input.workflowRunId ? "running" : "queued",
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
      !isDeepStrictEqual(row.payload?.mergeDeletePaths, input.deletePaths)
    )
      throw new Error("Write job id belongs to a different file command")
    if (!input.workflowRunId && row.payload?.revision) {
      if (
        !row.payload.workflowRunId &&
        row.status === WRITE_JOB_STATUSES.failed
      ) {
        await getOrgDb()
          .update(workspaceWriteJobs)
          .set({ status: WRITE_JOB_STATUSES.queued, updatedAt: new Date() })
          .where(
            and(
              eq(workspaceWriteJobs.id, input.id),
              eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.failed),
              sql`${workspaceWriteJobs.payload}->>'workflowRunId' is null`,
            ),
          )
      }
      return
    }
    const [claimed] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({ payload, status: values.status, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceWriteJobs.id, input.id),
          sql`${workspaceWriteJobs.commitSha} is null`,
          sql`(${workspaceWriteJobs.payload}->>'workflowRunId' is null or ${workspaceWriteJobs.payload}->>'workflowRunId' = ${input.workflowRunId ?? null})`,
          sql`(${workspaceWriteJobs.payload}->'revision' = ${JSON.stringify(input.revision)}::jsonb or (${workspaceWriteJobs.status} = 'paused' and ${workspaceWriteJobs.payload}->'revision' is null))`,
        ),
      )
      .returning({ id: workspaceWriteJobs.id })
    if (!claimed) throw new Error("Write job already has a workflow owner")
  })
}

/** A rejected enqueue may still have committed. Never fail a native scheduled run. */
export async function failUnscheduledWriteJob(jobId: string): Promise<void> {
  await orgSql(async () => {
    await getOrgDb()
      .update(workspaceWriteJobs)
      .set({ status: WRITE_JOB_STATUSES.failed, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.queued),
          sql`${workspaceWriteJobs.payload}->>'workflowRunId' is null`,
          sql`not exists (select 1 from openworkflow.workflow_runs scheduled
        where scheduled.input->>'orgId' = ${workspaceWriteJobs.orgId}
          and scheduled.input->>'workspaceId' = ${workspaceWriteJobs.workspaceId}
          and scheduled.input->>'jobId' = ${workspaceWriteJobs.id})`,
        ),
      )
  })
}
