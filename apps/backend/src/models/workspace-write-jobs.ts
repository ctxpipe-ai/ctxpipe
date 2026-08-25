import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm"
import { getOrgDb } from "../db/client.js"
import { workspaces, workspaceWriteJobs } from "../db/schema/workspaces.js"
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

