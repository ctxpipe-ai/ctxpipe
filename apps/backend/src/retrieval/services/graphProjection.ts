import { aliasedTable, and, eq, inArray, sql } from "drizzle-orm"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import { getOrgDb } from "../../db/client.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { objects } from "../../db/schema/objects.js"
import { getLogger, logWideEvent } from "../../observability/logger.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import { isValidGraphEdgeType } from "../schema/allowedConnections.js"
import type { ClaimForProjection } from "../schema/claimForProjection.js"

/** Lightweight fields to extract from payload per kind. Keep compact. */
const KIND_PAYLOAD_KEYS: Record<string, string[]> = {
  Service: ["owner_team", "tier", "language", "repository_ids"],
  App: ["platform", "package"],
  API: ["protocol", "version"],
  Stream: ["platform", "schema_name"],
  Database: ["engine", "cluster"],
  Infrastructure: ["infra_kind", "platform"],
  Library: ["language", "package"],
  Pattern: ["category"],
  Repository: [],
  Concept: [],
  Capability: [],
  Topic: [],
  Incident: [],
  Decision: [],
  InstructionUnit: ["intent", "modality", "path"],
  Skill: ["intent_summary"],
}

function extractNodeProps(
  id: string,
  kind: string,
  payload: Record<string, unknown> | null,
): Record<string, unknown> {
  const p = payload ?? {}
  const name = (p.name as string) ?? null
  const summary =
    typeof p.summary === "string" && p.summary.length <= 500 ? p.summary : null

  const props: Record<string, unknown> = {
    id,
    kind,
    name,
    summary,
  }

  const keys = KIND_PAYLOAD_KEYS[kind]
  if (keys) {
    for (const k of keys) {
      const v = p[k]
      if (v != null && typeof v !== "object") {
        props[k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) : v
      }
    }
  }

  return props
}

/**
 * Projects claims from graph state into FalkorDB.
 * Stores architecture/semantic nodes with enriched properties and predicate-typed edges.
 * Claims project as edges; full provenance remains in Postgres.
 */
export async function projectClaimsFromState(
  claims: ClaimForProjection[],
): Promise<{ projected: number; errors: string[] }> {
  const errors: string[] = []
  let projected = 0
  let skippedInvalidPredicate = 0
  const resolvedOrgId = requireCurrentOrgId()
  const resolvedOrgSlug = requireCurrentOrgSlug()
  const logger = getLogger()

  if (claims.length === 0) {
    logger.set({
      step: "graphProjection.summary",
      claimsReceived: 0,
      claimsProjectedToGraph: 0,
      skippedInvalidPredicate: 0,
    })
    logger.info("graph projection skipped (no claims)")
    return { projected: 0, errors: [] }
  }

  const uniqueIds = new Set<string>()
  for (const c of claims) {
    if (isValidGraphEdgeType(c.predicate)) {
      uniqueIds.add(c.subjectId)
      uniqueIds.add(c.objectId)
    }
  }

  const db = getOrgDb()
  const entityMap = new Map<
    string,
    { kind: string; payload: Record<string, unknown> }
  >()

  if (uniqueIds.size > 0) {
    const ids = [...uniqueIds]
    const rows = await db
      .select({
        id: objects.id,
        kind: objects.kind,
        payload: objects.payload,
      })
      .from(objects)
      .where(and(eq(objects.orgId, resolvedOrgId), inArray(objects.id, ids)))

    for (const r of rows) {
      entityMap.set(r.id, {
        kind: r.kind,
        payload: (r.payload ?? {}) as Record<string, unknown>,
      })
    }
  }

  logger.info("projectClaimsFromState: projecting claims to graph", {
    claimCount: claims.length,
  })

  await withGraphClient(
    { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
    async () => {
      const driver = getGraphClient()

      for (const c of claims) {
        if (!isValidGraphEdgeType(c.predicate)) {
          skippedInvalidPredicate++
          logger.warn(
            "projectClaimsFromState: skipping claim with invalid predicate",
            { claimId: c.id, predicate: c.predicate },
          )
          continue
        }

        const subjectEntity = entityMap.get(c.subjectId)
        const objectEntity = entityMap.get(c.objectId)

        const subjectProps = extractNodeProps(
          c.subjectId,
          c.subjectKind,
          subjectEntity?.payload ?? null,
        )
        const objectProps = extractNodeProps(
          c.objectId,
          c.objectKind,
          objectEntity?.payload ?? null,
        )

        const subjectLabel = c.subjectKind
        const objectLabel = c.objectKind
        const edgeType = c.predicate

        try {
          const subjectParams = Object.fromEntries(
            Object.entries(subjectProps).map(([k, v]) => [
              `subject_${k}`,
              v ?? "",
            ]),
          )
          const objectParams = Object.fromEntries(
            Object.entries(objectProps).map(([k, v]) => [
              `object_${k}`,
              v ?? "",
            ]),
          )

          const subjectSetClauses = [
            "s.orgId = $orgId",
            ...Object.keys(subjectProps).map((k) => `s.${k} = $subject_${k}`),
          ].join(", ")
          const objectSetClauses = [
            "o.orgId = $orgId",
            ...Object.keys(objectProps).map((k) => `o.${k} = $object_${k}`),
          ].join(", ")

          await driver.executeQuery(
            `MERGE (s:${subjectLabel} { id: $subject_id, orgId: $orgId })
             MERGE (o:${objectLabel} { id: $object_id, orgId: $orgId })
             SET ${subjectSetClauses}, ${objectSetClauses}
             MERGE (s)-[r:${edgeType}]->(o)
             SET r.claim_id = $claimId,
                 r.status = $status,
                 r.aggregate_confidence = $aggregateConfidence,
                 r.source_count = $sourceCount,
                 r.last_observed_at = $lastObservedAt,
                 r.valid_from = $validFrom,
                 r.valid_to = $validTo
             RETURN r`,
            {
              subject_id: c.subjectId,
              object_id: c.objectId,
              orgId: resolvedOrgId,
              ...subjectParams,
              ...objectParams,
              claimId: c.id,
              status: c.status,
              aggregateConfidence: c.aggregatedConfidence,
              sourceCount: c.sourceCount,
              lastObservedAt: c.lastObservedAt,
              validFrom: c.validFrom,
              validTo: c.validTo,
            },
          )
          projected++
        } catch (err) {
          const details: Record<string, unknown> = {
            claimId: c.id,
            subjectId: c.subjectId,
            objectId: c.objectId,
            subjectKind: c.subjectKind,
            objectKind: c.objectKind,
            predicate: c.predicate,
            error: err instanceof Error ? err.message : String(err),
          }
          if (err && typeof err === "object" && "gqlStatus" in err) {
            const ne = err as {
              gqlStatus?: string
              gqlStatusDescription?: string
              code?: string
              diagnosticRecord?: unknown
            }
            details.gqlStatus = ne.gqlStatus
            details.gqlStatusDescription = ne.gqlStatusDescription
            details.code = ne.code
            details.diagnosticRecord = ne.diagnosticRecord
          }
          logWideEvent(
            "error",
            "projectClaimsFromState: error projecting claim",
            details,
          )
          errors.push(
            `${c.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    },
  )

  if (errors.length > 0) {
    logger.set({
      step: "graphProjection.summary",
      claimsReceived: claims.length,
      claimsProjectedToGraph: projected,
      projectionErrors: errors.length,
      skippedInvalidPredicate,
    })
    logger.error("graph projection finished with errors")
    throw new Error(
      `Graph projection failed: ${errors.length}/${claims.length} claims (${errors[0]}${errors.length > 1 ? ` and ${errors.length - 1} more` : ""})`,
    )
  }

  logger.set({
    step: "graphProjection.summary",
    claimsReceived: claims.length,
    claimsProjectedToGraph: projected,
    projectionErrors: 0,
    skippedInvalidPredicate,
  })
  logger.info("graph projection complete")

  return { projected, errors }
}

/**
 * Removes an object node from FalkorDB when Postgres no longer references it.
 */
export async function deleteObjectFromGraph(objectId: string): Promise<void> {
  const resolvedOrgId = requireCurrentOrgId()
  const resolvedOrgSlug = requireCurrentOrgSlug()

  await withGraphClient(
    { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
    async () => {
      const driver = getGraphClient()
      await driver.executeQuery(
        `MATCH (n { id: $id, orgId: $orgId })
         DETACH DELETE n`,
        { id: objectId, orgId: resolvedOrgId },
      )
    },
  )
}

/**
 * Removes a claim edge from FalkorDB (Postgres remains source of truth).
 */
export async function retractClaimFromGraph(claimId: string): Promise<void> {
  const resolvedOrgId = requireCurrentOrgId()
  const resolvedOrgSlug = requireCurrentOrgSlug()

  await withGraphClient(
    { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
    async () => {
      const driver = getGraphClient()
      await driver.executeQuery(
        `MATCH (s)-[r]->(o)
         WHERE r.claim_id = $claimId AND s.orgId = $orgId AND o.orgId = $orgId
         DELETE r`,
        { claimId, orgId: resolvedOrgId },
      )
    },
  )
}

/**
 * Re-projects a single claim after aggregate or evidence changes.
 */
export async function refreshClaimProjection(claimId: string): Promise<void> {
  const resolvedOrgId = requireCurrentOrgId()
  const db = getOrgDb()
  const subjectRo = aliasedTable(objects, "subject_ro")
  const objectRo = aliasedTable(objects, "object_ro")

  const rows = await db
    .select({
      id: claims.id,
      subjectId: claims.subjectId,
      objectId: claims.objectId,
      subjectKind: subjectRo.kind,
      objectKind: objectRo.kind,
      predicate: claims.predicate,
      status: claims.status,
      aggregatedConfidence: claims.aggregatedConfidence,
      lastObservedAt: claims.lastObservedAt,
      validFrom: claims.validFrom,
      validTo: claims.validTo,
    })
    .from(claims)
    .innerJoin(subjectRo, eq(claims.subjectId, subjectRo.id))
    .innerJoin(objectRo, eq(claims.objectId, objectRo.id))
    .where(
      and(
        eq(claims.orgId, resolvedOrgId),
        eq(claims.id, claimId),
        eq(subjectRo.orgId, resolvedOrgId),
        eq(objectRo.orgId, resolvedOrgId),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) return

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(claimEvidence)
    .where(eq(claimEvidence.claimId, claimId))

  const sourceCount = countRow?.count ?? 0

  await projectClaimsFromState([
    {
      id: row.id,
      subjectId: row.subjectId,
      objectId: row.objectId,
      subjectKind: row.subjectKind,
      objectKind: row.objectKind,
      predicate: row.predicate,
      status: row.status,
      aggregatedConfidence: row.aggregatedConfidence,
      sourceCount,
      lastObservedAt: row.lastObservedAt.toISOString(),
      validFrom: row.validFrom?.toISOString() ?? null,
      validTo: row.validTo?.toISOString() ?? null,
    },
  ])
}
