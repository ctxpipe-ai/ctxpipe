import { isDeepStrictEqual } from "node:util"
import { and, asc, eq, isNotNull, ne, notInArray, sql } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import {
  workspaceKnowledgePathState,
  workspaces,
  workspaceWriteJobs,
} from "../db/schema/workspaces.js"
import type { ConnectorMirrorSource } from "../domain/workspaces/connector-mirror.js"
import {
  sameWorkspaceRevision,
  type WorkspaceRevision,
} from "../domain/workspaces/revision.js"
import type { WorkspaceWriteKind } from "../domain/workspaces/write-commit-files.js"
import {
  type WorkspaceWriteJobPayload,
  WRITE_JOB_STATUSES,
} from "../domain/workspaces/write-job-intent.js"
import type { GitFileChange } from "../services/git/file-change.js"
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
      .onConflictDoNothing()
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(eq(workspaceWriteJobs.id, input.id))
      .limit(1)
    if (
      !row ||
      row.workspaceId !== input.workspaceId ||
      row.kind !== input.kind ||
      row.generation !== input.generation ||
      row.desiredSha !== (input.desiredSha ?? null)
    )
      throw new Error("Write job id belongs to a different command")
    for (const key of [
      "jobWorkspaceUrl",
      "previousSha",
      "displayName",
      "linkAction",
      "linkGitUrl",
      "mirror",
      "mergeFiles",
      "mergeDeletePaths",
      "conflictParentSha",
      "remoteTipSha",
    ] as const) {
      if (!isDeepStrictEqual(row.payload?.[key], input.payload[key]))
        throw new Error("Write job id belongs to a different captured payload")
    }
    if (
      input.payload.defaultBranch !== undefined &&
      row.payload?.defaultBranch !== input.payload.defaultBranch
    )
      throw new Error("Write job id belongs to a different default branch")
    // Re-admission is a read: a paused fallback never changes an existing native owner or status.
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
    const [row] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({ status, updatedAt: new Date() })
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

const migrationExportTip = sql<
  string | null
>`coalesce(${workspaceWriteJobs.payload}->>'exportTipSha', ${workspaceWriteJobs.commitSha})`

/** A completed empty export still has a cutover revision, but created no commit. */
export async function persistMigrationExportNoOp(
  jobId: string,
  sha: string,
  unpublishedCommitSha?: string,
): Promise<void> {
  await orgSql(async () => {
    const [row] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        commitSha: null,
        payload: sql`jsonb_set(coalesce(${workspaceWriteJobs.payload}, '{}'::jsonb), '{exportTipSha}', to_jsonb(${sha}::text))`,
        status: WRITE_JOB_STATUSES.completed,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceWriteJobs.id, jobId),
          eq(workspaceWriteJobs.kind, "migration_export"),
          ne(workspaceWriteJobs.status, WRITE_JOB_STATUSES.completed),
          sql`(${workspaceWriteJobs.commitSha} is null or ${workspaceWriteJobs.commitSha} = ${unpublishedCommitSha ?? null})`,
        ),
      )
      .returning()
    if (!row) {
      const [existing] = await getOrgDb()
        .select()
        .from(workspaceWriteJobs)
        .where(eq(workspaceWriteJobs.id, jobId))
        .limit(1)
      if (
        existing?.kind === "migration_export" &&
        existing.status === WRITE_JOB_STATUSES.completed &&
        existing.commitSha === null &&
        existing.payload?.exportTipSha === sha
      )
        return
      throw new Error(
        "Migration export is unavailable or already has a candidate commit",
      )
    }
    await projectCompletedKnowledgePaths(row)
  })
}

export async function listMigrationExportShas(): Promise<Map<string, string>> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select({
        workspaceId: workspaceWriteJobs.workspaceId,
        commitSha: migrationExportTip,
      })
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.kind, "migration_export"),
          isNotNull(migrationExportTip),
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.completed),
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
      .select({ commitSha: migrationExportTip })
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.workspaceId, workspaceId),
          eq(workspaceWriteJobs.kind, "migration_export"),
          isNotNull(migrationExportTip),
          eq(workspaceWriteJobs.status, WRITE_JOB_STATUSES.completed),
        ),
      )
      .orderBy(asc(workspaceWriteJobs.createdAt))
      .limit(1)
    return row?.commitSha ?? null
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
    if (
      row.payload.semanticHandoff &&
      !isDeepStrictEqual(row.payload.semanticHandoff, handoff)
    )
      throw new Error("Write job already has a different semantic handoff")
    await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        payload: { ...row.payload, semanticHandoff: handoff },
        updatedAt: new Date(),
      })
      .where(eq(workspaceWriteJobs.id, input.jobId))
    return {
      ownerRunId: handoff.ownerRunId,
      candidateSha: handoff.candidateSha,
    }
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
    if (row.status !== "running")
      throw new Error("Semantic parent is not running")
    if (preparedSha) {
      if (
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
  files?: GitFileChange[]
  deletePaths?: string[]
  workflowRunId?: string
  linkAction?: "link" | "unlink"
  linkGitUrl?: string
  displayName?: string
  previousSha?: string
  mirror?: ConnectorMirrorSource
}) {
  return orgSql(async () => {
    const payload: WorkspaceWriteJobPayload = {
      revision: input.revision,
      ...(input.mirror ? { mirror: input.mirror } : {}),
      ...(input.previousSha ? { previousSha: input.previousSha } : {}),
      ...(input.displayName !== undefined
        ? { displayName: input.displayName }
        : {}),
      ...(input.files ? { mergeFiles: input.files } : {}),
      ...(input.linkAction
        ? { linkAction: input.linkAction, linkGitUrl: input.linkGitUrl }
        : {}),
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
      !isDeepStrictEqual(row.payload?.mergeDeletePaths, input.deletePaths) ||
      row.payload?.linkAction !== input.linkAction ||
      row.payload?.linkGitUrl !== input.linkGitUrl ||
      !isDeepStrictEqual(row.payload?.mirror, input.mirror) ||
      row.payload?.previousSha !== input.previousSha ||
      row.payload?.displayName !== input.displayName
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
          sql`(${workspaceWriteJobs.payload}->'revision' = ${JSON.stringify(input.revision)}::jsonb or (${workspaceWriteJobs.status} in ('paused', 'queued') and ${workspaceWriteJobs.payload}->'revision' is null))`,
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
