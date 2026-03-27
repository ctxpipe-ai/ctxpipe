import { and, eq, inArray } from "drizzle-orm"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import { getOrgDb } from "../../db/client.js"
import { retrievalObjects } from "../../db/schema/retrieval_objects.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import {
  isValidGraphEdgeType,
} from "../schema/allowedConnections.js"
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
  const resolvedOrgId = requireCurrentOrgId()
  const resolvedOrgSlug = requireCurrentOrgSlug()

  if (claims.length === 0) {
    console.debug("projectClaimsFromState: no claims to project")
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
        id: retrievalObjects.id,
        kind: retrievalObjects.kind,
        payload: retrievalObjects.payload,
      })
      .from(retrievalObjects)
      .where(
        and(
          eq(retrievalObjects.orgId, resolvedOrgId),
          inArray(retrievalObjects.id, ids),
        ),
      )

    for (const r of rows) {
      entityMap.set(r.id, {
        kind: r.kind,
        payload: (r.payload ?? {}) as Record<string, unknown>,
      })
    }
  }

  console.debug(
    "projectClaimsFromState: projecting",
    claims.length,
    "claims to graph",
  )

  await withGraphClient(
    { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
    async () => {
      const driver = getGraphClient()

      for (const c of claims) {
        if (!isValidGraphEdgeType(c.predicate)) {
          console.warn(
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
          console.error("projectClaimsFromState: error projecting claim", details)
          errors.push(
            `${c.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    },
  )

  if (errors.length > 0) {
    throw new Error(
      `Graph projection failed: ${errors.length}/${claims.length} claims (${errors[0]}${errors.length > 1 ? ` and ${errors.length - 1} more` : ""})`,
    )
  }

  return { projected, errors }
}
