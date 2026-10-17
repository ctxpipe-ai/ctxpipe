import { eq } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { withAmbientOrgDb } from "../db/org-sql.js"
import { claimEvidence } from "../db/schema/claim_evidence.js"
import { claims } from "../db/schema/claims.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import { orgFirstWorkspaces, workspaces } from "../db/schema/workspaces.js"
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

export async function loadKnowledgeProjectionSource(): Promise<
  RepositoryWorkspaceMaps & {
    objects: ExportObjectRow[]
    claims: ExportClaimRow[]
  }
> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const [objectRows, claimRows, evidenceRows, maps] = await Promise.all([
      db
        .select({
          id: objects.id,
          kind: objects.kind,
          deduplicationKey: objects.deduplicationKey,
          payload: objects.payload,
        })
        .from(objects)
        .where(eq(objects.orgId, orgId)),
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
        .where(eq(claims.orgId, orgId)),
      db
        .select({
          claimId: claimEvidence.claimId,
          sourceType: claimEvidence.sourceType,
          logicalSourceKey: claimEvidence.logicalSourceKey,
        })
        .from(claimEvidence),
      loadRepositoryWorkspaceMaps(),
    ])

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
      objects: objectRows.map((row) => ({
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
          // A claim with no `valid_from` holds since ctx| first saw it. With
          // a date in the file, hydrate has no `valid_from` to write after
          // the upgrade.
          validFrom: row.validFrom ?? row.firstObservedAt,
          validTo: row.validTo,
          evidenceKey: sourceByClaim.get(row.id) ?? null,
        })),
    }
  })
}
