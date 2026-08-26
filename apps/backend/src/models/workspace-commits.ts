import { and, desc, eq, lt, sql } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import {
  workspaceCommitProjections,
  workspaceRepositoryCommits,
} from "../db/schema/workspaces.js"
import {
  type ProjectedCommit,
  pruneCutoff,
} from "../domain/workspaces/commit-activity.js"
import { orgSql } from "./workspace-sql.js"

export type WorkspaceCommitProjectionRecord =
  typeof workspaceCommitProjections.$inferSelect

export async function getWorkspaceCommitProjection(
  workspaceId: string,
): Promise<WorkspaceCommitProjectionRecord | null> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const [row] = await db
      .select()
      .from(workspaceCommitProjections)
      .where(
        and(
          eq(workspaceCommitProjections.orgId, orgId),
          eq(workspaceCommitProjections.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    return row ?? null
  })
}

export async function listWorkspaceRepositoryCommits(input: {
  workspaceId: string
  limit?: number
}): Promise<ProjectedCommit[]> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const rows = await db
      .select()
      .from(workspaceRepositoryCommits)
      .where(
        and(
          eq(workspaceRepositoryCommits.orgId, orgId),
          eq(workspaceRepositoryCommits.workspaceId, input.workspaceId),
        ),
      )
      .orderBy(desc(workspaceRepositoryCommits.committedAt))
      .limit(input.limit ?? 5)
    return rows.map((row) => ({
      sha: row.sha,
      committedAt: row.committedAt,
      authorName: row.authorName,
      subject: row.subject,
      htmlUrl: row.htmlUrl,
    }))
  })
}

export async function listWorkspaceCommitDayCounts(
  workspaceId: string,
): Promise<Map<string, number>> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const rows = await db
      .select({
        day: sql<string>`to_char(timezone('UTC', ${workspaceRepositoryCommits.committedAt}), 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(workspaceRepositoryCommits)
      .where(
        and(
          eq(workspaceRepositoryCommits.orgId, orgId),
          eq(workspaceRepositoryCommits.workspaceId, workspaceId),
        ),
      )
      .groupBy(
        sql`to_char(timezone('UTC', ${workspaceRepositoryCommits.committedAt}), 'YYYY-MM-DD')`,
      )
    return new Map(
      rows.map(
        (row) => [row.day, Number(row.count)] satisfies [string, number],
      ),
    )
  })
}

export async function listWorkspaceCommitShas(
  workspaceId: string,
): Promise<Set<string>> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const rows = await db
      .select({ sha: workspaceRepositoryCommits.sha })
      .from(workspaceRepositoryCommits)
      .where(
        and(
          eq(workspaceRepositoryCommits.orgId, orgId),
          eq(workspaceRepositoryCommits.workspaceId, workspaceId),
        ),
      )
    return new Set(rows.map((row) => row.sha))
  })
}

export async function insertWorkspaceRepositoryCommits(input: {
  workspaceId: string
  commits: readonly ProjectedCommit[]
}): Promise<void> {
  if (input.commits.length === 0) return
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    await db
      .insert(workspaceRepositoryCommits)
      .values(
        input.commits.map((commit) => ({
          orgId,
          workspaceId: input.workspaceId,
          sha: commit.sha,
          committedAt: commit.committedAt,
          authorName: commit.authorName,
          subject: commit.subject,
          htmlUrl: commit.htmlUrl,
        })),
      )
      .onConflictDoNothing({
        target: [
          workspaceRepositoryCommits.workspaceId,
          workspaceRepositoryCommits.sha,
        ],
      })
  })
}

export async function pruneWorkspaceRepositoryCommits(
  workspaceId: string,
  now = new Date(),
): Promise<void> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    await db
      .delete(workspaceRepositoryCommits)
      .where(
        and(
          eq(workspaceRepositoryCommits.orgId, orgId),
          eq(workspaceRepositoryCommits.workspaceId, workspaceId),
          lt(workspaceRepositoryCommits.committedAt, pruneCutoff(now)),
        ),
      )
  })
}

export async function upsertWorkspaceCommitProjection(input: {
  workspaceId: string
  headSha: string | null
  backfillStatus: "pending" | "ready" | "failed"
  backfilledSince?: Date | null
}): Promise<void> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    await db
      .insert(workspaceCommitProjections)
      .values({
        workspaceId: input.workspaceId,
        orgId,
        headSha: input.headSha,
        backfillStatus: input.backfillStatus,
        backfilledSince: input.backfilledSince ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaceCommitProjections.workspaceId,
        set: {
          headSha: input.headSha,
          backfillStatus: input.backfillStatus,
          backfilledSince: input.backfilledSince ?? null,
          updatedAt: new Date(),
        },
      })
  })
}
