import { and, eq, inArray, type SQL, sql } from "drizzle-orm"

import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { withAmbientOrgDb } from "../db/org-sql.js"
import { claimEvidence } from "../db/schema/claim_evidence.js"
import { claims } from "../db/schema/claims.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import {
  orgFirstWorkspaces,
  workspaces,
  workspaceWriteJobs,
} from "../db/schema/workspaces.js"
import {
  isReingestUpgradeKey,
  reingestedNames,
  UPGRADE_JOB_KIND,
} from "../domain/upgrades/keys.js"
import type {
  ExportClaimRow,
  ExportObjectRow,
} from "../domain/workspaces/migration-export.js"
import {
  repositoryIdFromDedup,
  workspaceByRepositoryUrl,
} from "../domain/workspaces/migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

/** The org repositories of main and the Workspace of each, with no knowledge rows. */
export type RepositoryWorkspaceMaps = {
  firstWorkspaceId: string | null
  workspaceByRepositoryId: Map<string, string>
  repositoryGitUrlById: Map<string, string>
  /** The GitHub connection of each org repository, or null when it has none. */
  repositoryConnectionById: Map<string, string | null>
}

/**
 * The repository and Workspace maps of the current org. It reads only the
 * repositories, the Workspaces and the first Workspace, not the knowledge
 * store, so the upgrade scan can call it for each Workspace.
 */
export async function loadRepositoryWorkspaceMaps(): Promise<RepositoryWorkspaceMaps> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const [repoRows, workspaceRows, firstWorkspaceRow] = await Promise.all([
      db
        .select({
          id: repositories.id,
          gitUrl: repositories.gitUrl,
          githubConnectionId: repositories.githubConnectionId,
        })
        .from(repositories)
        .where(eq(repositories.orgId, orgId)),
      db
        .select({
          id: workspaces.id,
          workspaceRepositoryUrl: workspaces.workspaceRepositoryUrl,
          createdAt: workspaces.createdAt,
        })
        .from(workspaces)
        .where(eq(workspaces.orgId, orgId)),
      db
        .select({ workspaceId: orgFirstWorkspaces.workspaceId })
        .from(orgFirstWorkspaces)
        .where(eq(orgFirstWorkspaces.orgId, orgId))
        .limit(1),
    ])
    return {
      firstWorkspaceId: firstWorkspaceRow[0]?.workspaceId ?? null,
      workspaceByRepositoryId: workspaceByRepositoryUrl({
        repositories: repoRows,
        workspaces: workspaceRows,
        normalizeUrl: normalizeWorkspaceRepositoryUrl,
      }),
      repositoryGitUrlById: new Map(
        repoRows.map((row) => [row.id, row.gitUrl]),
      ),
      repositoryConnectionById: new Map(
        repoRows.map((row) => [row.id, row.githubConnectionId]),
      ),
    }
  })
}

/**
 * The repository id of an object row from its deduplication key, in SQL: the
 * same pattern as {@link repositoryIdFromDedup}.
 */
const dedupRepositoryId = sql`nullif(btrim(substring(btrim(${objects.deduplicationKey}) from '^[^:]+:([^:]+):')), '')`

/**
 * The SQL filter of the object rows that Workspace `workspaceId` can get.
 * A row with no deduplication key stays: its repository can come from the
 * evidence of its claims. The caller applies the exact assignment.
 */
function workspaceObjectFilter(input: {
  workspaceId: string
  maps: RepositoryWorkspaceMaps
}): SQL {
  const ids = (list: readonly string[]) =>
    sql.join(
      list.map((id) => sql`${id}`),
      sql`, `,
    )
  const own: string[] = []
  const other: string[] = []
  for (const [id, workspaceId] of input.maps.workspaceByRepositoryId)
    (workspaceId === input.workspaceId ? own : other).push(id)
  // The first Workspace gets each repository that no other Workspace has.
  const keyed =
    input.maps.firstWorkspaceId === input.workspaceId
      ? other.length
        ? sql`(${dedupRepositoryId} is null or ${dedupRepositoryId} not in (${ids(other)}))`
        : sql`true`
      : own.length
        ? sql`${dedupRepositoryId} in (${ids(own)})`
        : sql`false`
  return sql`(${objects.deduplicationKey} is null or ${keyed})`
}

/**
 * The main-era knowledge rows (objects, claims and their evidence keys) with
 * the repository and Workspace maps. With `workspaceId`, it reads only the
 * rows that this Workspace can get, so that hydrate does not read all rows
 * of the org.
 */
export async function loadKnowledgeProjectionSource(
  scope: { workspaceId: string } | null = null,
): Promise<
  RepositoryWorkspaceMaps & {
    objects: ExportObjectRow[]
    claims: ExportClaimRow[]
  }
> {
  const maps = await loadRepositoryWorkspaceMaps()
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const objectFilter = scope
      ? and(eq(objects.orgId, orgId), workspaceObjectFilter({ ...scope, maps }))
      : eq(objects.orgId, orgId)
    const objectIds = db
      .select({ id: objects.id })
      .from(objects)
      .where(objectFilter)
    const claimFilter = scope
      ? and(eq(claims.orgId, orgId), inArray(claims.subjectId, objectIds))
      : eq(claims.orgId, orgId)
    const [objectRows, targetRows, claimRows, evidenceRows] = await Promise.all(
      [
        db
          .select({
            id: objects.id,
            kind: objects.kind,
            deduplicationKey: objects.deduplicationKey,
            payload: objects.payload,
          })
          .from(objects)
          .where(objectFilter),
        // A link of this Workspace to an object of another Workspace is
        // dropped. The note of the drop names the target, as in upgrade step
        // 1, so the target comes with its name only.
        scope
          ? db
              .select({
                id: objects.id,
                kind: objects.kind,
                deduplicationKey: objects.deduplicationKey,
                payload: sql<
                  Record<string, unknown>
                >`jsonb_strip_nulls(jsonb_build_object('title', ${objects.payload}->'title', 'name', ${objects.payload}->'name'))`,
              })
              .from(objects)
              .where(
                and(
                  eq(objects.orgId, orgId),
                  inArray(
                    objects.id,
                    db
                      .select({ id: claims.objectId })
                      .from(claims)
                      .where(claimFilter),
                  ),
                  sql`not (${objectFilter})`,
                ),
              )
          : [],
        db
          .select({
            id: claims.id,
            subjectId: claims.subjectId,
            objectId: claims.objectId,
            predicate: claims.predicate,
            aggregatedConfidence: claims.aggregatedConfidence,
            validFrom: claims.validFrom,
            validTo: claims.validTo,
            firstObservedAt: claims.firstObservedAt,
            status: claims.status,
          })
          .from(claims)
          .where(claimFilter),
        db
          .select({
            claimId: claimEvidence.claimId,
            sourceType: claimEvidence.sourceType,
            logicalSourceKey: claimEvidence.logicalSourceKey,
          })
          .from(claimEvidence)
          .where(
            scope
              ? inArray(
                  claimEvidence.claimId,
                  db.select({ id: claims.id }).from(claims).where(claimFilter),
                )
              : undefined,
          ),
      ],
    )

    const sourceByClaim = new Map<string, string>()
    for (const row of evidenceRows) {
      if (sourceByClaim.has(row.claimId)) continue
      const key = row.logicalSourceKey?.trim()
      if (key) sourceByClaim.set(row.claimId, key)
    }

    const evidenceKeyByObject = new Map<string, string>()
    for (const claim of claimRows) {
      const key = sourceByClaim.get(claim.id)
      if (!key || !repositoryIdFromDedup(key)) continue
      if (!evidenceKeyByObject.has(claim.subjectId)) {
        evidenceKeyByObject.set(claim.subjectId, key)
      }
    }

    return {
      ...maps,
      objects: [...objectRows, ...targetRows].map((row) => ({
        id: row.id,
        kind: row.kind,
        deduplicationKey:
          row.deduplicationKey ?? evidenceKeyByObject.get(row.id) ?? null,
        payload: row.payload,
      })),
      claims: claimRows
        .filter((row) => row.status === "active")
        .map((row) => ({
          subjectId: row.subjectId,
          objectId: row.objectId,
          predicate: row.predicate,
          aggregatedConfidence: row.aggregatedConfidence,
          // A claim with no `valid_from` holds since ctxpipe first saw it. With
          // a date in the file, hydrate has no `valid_from` to write after
          // the upgrade.
          validFrom: row.validFrom ?? row.firstObservedAt,
          validTo: row.validTo,
          evidenceKey: sourceByClaim.get(row.id) ?? null,
        })),
    }
  })
}

/**
 * The GitHub source repositories (`owner/name`, lower case) that a
 * re-ingestion of this Workspace did. Any skill bundle counts: each bundle
 * makes the knowledge of the repository again, so after a new bundle the
 * main-era knowledge must not come back. A row keeps these marks when a
 * later run or a new bundle replaces its reports.
 */
export async function reingestedRepositories(
  workspaceId: string,
): Promise<Set<string>> {
  const rows = await orgSql(() =>
    getOrgDb()
      .select({ payload: workspaceWriteJobs.payload })
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.workspaceId, workspaceId),
          eq(workspaceWriteJobs.kind, UPGRADE_JOB_KIND),
        ),
      ),
  )
  return new Set(
    reingestedNames(
      ...rows.flatMap(({ payload }) =>
        payload?.upgrade && isReingestUpgradeKey(payload.upgrade.key)
          ? [payload.upgrade]
          : [],
      ),
    ),
  )
}
