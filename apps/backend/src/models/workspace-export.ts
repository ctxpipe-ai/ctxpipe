import { eq } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
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
import { withAmbientOrgDb } from "../db/org-sql.js"

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

export async function loadMigrationExportSource(): Promise<{
  firstWorkspaceId: string | null
  workspaceByRepositoryId: Map<string, string>
  repositoryGitUrlById: Map<string, string>
  objects: ExportObjectRow[]
  claims: ExportClaimRow[]
}> {
  return orgSql(async () => {
    const orgId = requireCurrentOrgId()
    const db = getOrgDb()
    const [
      objectRows,
      claimRows,
      evidenceRows,
      repoRows,
      workspaceRows,
      firstWorkspaceRow,
    ] = await Promise.all([
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
        db
          .select({ id: repositories.id, gitUrl: repositories.gitUrl })
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

    const firstWorkspaceId = firstWorkspaceRow[0]?.workspaceId ?? null

    return {
      firstWorkspaceId,
      workspaceByRepositoryId: workspaceByRepositoryUrl({
        repositories: repoRows,
        workspaces: workspaceRows,
        normalizeUrl: normalizeWorkspaceRepositoryUrl,
      }),
      repositoryGitUrlById: new Map(
        repoRows.map((row) => [row.id, row.gitUrl]),
      ),
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
          validFrom: row.validFrom,
          validTo: row.validTo,
          evidenceKey: sourceByClaim.get(row.id) ?? null,
        })),
    }
  })
}
