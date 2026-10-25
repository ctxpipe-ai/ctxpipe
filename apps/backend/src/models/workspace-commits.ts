import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm"

import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import {
  workspaceCommitProjections,
  workspaceRepositoryCommits,
  workspaces,
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

type WorkspaceActivityCommitRecord = ProjectedCommit & {
  workspaceId: string
  workspaceSlug: string
  workspaceName: string
}

/**
 * The latest commits first, of one workspace or (no `workspaceId`) of every
 * workspace in the org. `date` (`YYYY-MM-DD`) keeps only the commits of that
 * UTC day, the same day boundary as `listWorkspaceCommitDayCounts`.
 */
export async function listWorkspaceRepositoryCommits(input: {
  workspaceId?: string
  date?: string
  limit?: number
  /** Optional author, date range, and keyset filters of the activity list. */
  filters?: WorkspaceCommitListFilters
}): Promise<WorkspaceActivityCommitRecord[]> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const dayStart = input.date ? new Date(`${input.date}T00:00:00.000Z`) : null
    const rows = await db
      .select({
        commit: workspaceRepositoryCommits,
        workspaceSlug: workspaces.slug,
        workspaceName: workspaces.displayName,
      })
      .from(workspaceRepositoryCommits)
      .innerJoin(
        workspaces,
        eq(workspaces.id, workspaceRepositoryCommits.workspaceId),
      )
      .where(
        and(
          eq(workspaceRepositoryCommits.orgId, orgId),
          eq(workspaces.orgId, orgId),
          input.workspaceId
            ? eq(workspaceRepositoryCommits.workspaceId, input.workspaceId)
            : undefined,
          dayStart
            ? gte(workspaceRepositoryCommits.committedAt, dayStart)
            : undefined,
          dayStart
            ? lt(
                workspaceRepositoryCommits.committedAt,
                new Date(dayStart.getTime() + 86_400_000),
              )
            : undefined,
          ...commitListConditions(input.filters),
        ),
      )
      .orderBy(
        desc(workspaceRepositoryCommits.committedAt),
        workspaceRepositoryCommits.sha,
        workspaceRepositoryCommits.workspaceId,
      )
      .limit(input.limit ?? 5)
    return rows.map(({ commit, workspaceSlug, workspaceName }) => ({
      sha: commit.sha,
      committedAt: commit.committedAt,
      authorName: commit.authorName,
      authorLogin: commit.authorLogin,
      subject: commit.subject,
      htmlUrl: commit.htmlUrl,
      workspaceId: commit.workspaceId,
      workspaceSlug,
      workspaceName,
    }))
  })
}

/**
 * The filters of the Home activity list. `since` and `until` are UTC days
 * (`YYYY-MM-DD`), both inclusive. `after` is the last row of the previous page
 * in the list order (newest first, then SHA, then workspace id).
 */
export type WorkspaceCommitListFilters = {
  author?: string
  since?: string
  until?: string
  after?: { committedAt: Date; sha: string; workspaceId: string }
}

function commitListConditions(
  filters: WorkspaceCommitListFilters | undefined,
): (SQL | undefined)[] {
  if (!filters) return []
  const commits = workspaceRepositoryCommits
  const after = filters.after
  return [
    filters.author ? eq(commits.authorName, filters.author) : undefined,
    filters.since
      ? gte(commits.committedAt, new Date(`${filters.since}T00:00:00.000Z`))
      : undefined,
    filters.until
      ? lt(
          commits.committedAt,
          new Date(
            new Date(`${filters.until}T00:00:00.000Z`).getTime() + 86_400_000,
          ),
        )
      : undefined,
    after
      ? or(
          lt(commits.committedAt, after.committedAt),
          and(
            eq(commits.committedAt, after.committedAt),
            or(
              sql`${commits.sha} > ${after.sha}`,
              and(
                eq(commits.sha, after.sha),
                sql`${commits.workspaceId} > ${after.workspaceId}`,
              ),
            ),
          ),
        )
      : undefined,
  ]
}

/**
 * The authors of the stored commits (the heatmap window), of one workspace or
 * (no `workspaceId`) of the org. The most active author is first.
 */
export async function listWorkspaceCommitAuthors(
  workspaceId?: string,
): Promise<{ name: string; count: number; login: string | null }[]> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const count = sql<number>`count(*)::int`
    const rows = await db
      .select({
        name: workspaceRepositoryCommits.authorName,
        count,
        // One GitHub login of the author, for the avatar.
        login: sql<
          string | null
        >`max(nullif(${workspaceRepositoryCommits.authorLogin}, ''))`,
      })
      .from(workspaceRepositoryCommits)
      .where(
        and(
          eq(workspaceRepositoryCommits.orgId, orgId),
          workspaceId
            ? eq(workspaceRepositoryCommits.workspaceId, workspaceId)
            : undefined,
        ),
      )
      .groupBy(workspaceRepositoryCommits.authorName)
      .orderBy(desc(count), workspaceRepositoryCommits.authorName)
    return rows.map((row) => ({
      name: row.name,
      count: Number(row.count),
      login: row.login ?? null,
    }))
  })
}

/** Commits per UTC day, of one workspace or (no `workspaceId`) of the org. */
export async function listWorkspaceCommitDayCounts(
  workspaceId?: string,
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
          workspaceId
            ? eq(workspaceRepositoryCommits.workspaceId, workspaceId)
            : undefined,
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

/** Every workspace in the org with its commit projection (null: none yet). */
export async function listOrgWorkspaceCommitProjections(): Promise<
  {
    workspace: {
      id: string
      orgId: string
      desiredSha: string | null
      slug: string
      name: string
    }
    projection: WorkspaceCommitProjectionRecord | null
  }[]
> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    return db
      .select({
        workspace: {
          id: workspaces.id,
          orgId: workspaces.orgId,
          desiredSha: workspaces.desiredSha,
          slug: workspaces.slug,
          name: workspaces.displayName,
        },
        projection: workspaceCommitProjections,
      })
      .from(workspaces)
      .leftJoin(
        workspaceCommitProjections,
        eq(workspaceCommitProjections.workspaceId, workspaces.id),
      )
      .where(eq(workspaces.orgId, orgId))
  })
}

/**
 * The SHAs of the stored commits that need no new read. A row with a null
 * login (from before the login column) is read again once; `""` means
 * checked, no GitHub user.
 */
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
          isNotNull(workspaceRepositoryCommits.authorLogin),
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
          authorLogin: commit.authorLogin ?? null,
          subject: commit.subject,
          htmlUrl: commit.htmlUrl,
        })),
      )
      .onConflictDoUpdate({
        target: [
          workspaceRepositoryCommits.workspaceId,
          workspaceRepositoryCommits.sha,
        ],
        set: { authorLogin: sql`excluded.author_login` },
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
