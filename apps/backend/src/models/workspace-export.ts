import { eq } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { claimEvidence } from "../db/schema/claim_evidence.js"
import { claims } from "../db/schema/claims.js"
import { objects } from "../db/schema/objects.js"
import { repositories } from "../db/schema/repositories.js"
import { orgWorkspaceCutover, workspaces } from "../db/schema/workspaces.js"
import {
  firstConnectorTarget,
  firstWorkspaceIdForCutover,
} from "../domain/workspaces/migration-cutover.js"
import type {
  ExportClaimRow,
  ExportObjectRow,
} from "../domain/workspaces/migration-export.js"
import {
  repositoryIdFromDedup,
  workspaceByRepositoryUrl,
} from "../domain/workspaces/migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { persistFirstWorkspaceId } from "./workspaces.js"

export async function loadMigrationExportSource(): Promise<{
  firstWorkspaceId: string | null
  workspaceByRepositoryId: Map<string, string>
  objects: ExportObjectRow[]
  claims: ExportClaimRow[]
}> {
  const orgId = requireCurrentOrgId()
  const db = getOrgDb()
  const [
    objectRows,
    claimRows,
    evidenceRows,
    repoRows,
    workspaceRows,
    cutover,
  ] = await Promise.all([
    db
      .select({
        id: objects.id,
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
      .select({ firstWorkspaceId: orgWorkspaceCutover.firstWorkspaceId })
      .from(orgWorkspaceCutover)
      .where(eq(orgWorkspaceCutover.orgId, orgId))
      .limit(1),
  ])

  const sourceByClaim = new Map<string, string>()
  for (const row of evidenceRows) {
    if (sourceByClaim.has(row.claimId)) continue
    const source = row.logicalSourceKey?.trim() || row.sourceType.trim()
    if (source) sourceByClaim.set(row.claimId, source)
  }

  const evidenceKeyByObject = new Map<string, string>()
  for (const claim of claimRows) {
    const key = sourceByClaim.get(claim.id)
    if (!key || !repositoryIdFromDedup(key)) continue
    if (!evidenceKeyByObject.has(claim.subjectId)) {
      evidenceKeyByObject.set(claim.subjectId, key)
    }
  }

  const firstWorkspaceId = firstWorkspaceIdForCutover({
    persistedFirstWorkspaceId: cutover[0]?.firstWorkspaceId ?? null,
    currentWorkspaceIds: workspaceRows.map((row) => row.id),
    computedFirstWorkspaceId: firstConnectorTarget(workspaceRows)?.id ?? null,
  })
  if (firstWorkspaceId && !cutover[0]) {
    await persistFirstWorkspaceId(firstWorkspaceId)
  }

  return {
    firstWorkspaceId,
    workspaceByRepositoryId: workspaceByRepositoryUrl({
      repositories: repoRows,
      workspaces: workspaceRows,
      normalizeUrl: normalizeWorkspaceRepositoryUrl,
    }),
    objects: objectRows.map((row) => ({
      id: row.id,
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
        source: sourceByClaim.get(row.id) ?? null,
      })),
  }
}
