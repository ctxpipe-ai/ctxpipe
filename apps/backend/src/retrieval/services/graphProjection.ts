import { aliasedTable, and, eq, inArray, sql } from "drizzle-orm"
import {
  requireCurrentOrgId,
  requireCurrentOrgSlug,
} from "../../auth/context.js"
import { getOrgDb, getSystemDb } from "../../db/client.js"
import { withAmbientOrgDb } from "../../db/org-sql.js"
import { claimEvidence } from "../../db/schema/claim_evidence.js"
import { claims } from "../../db/schema/claims.js"
import { objects } from "../../db/schema/objects.js"
import { replaceWorkspaceGraphCypher } from "../../domain/workspaces/derived-stores.js"
import { flushWorkflowLog, getLogger, log } from "../../observability/logger.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import { isValidGraphEdgeType } from "../schema/allowedConnections.js"
import type { ClaimForProjection } from "../schema/claimForProjection.js"

export type GraphProjectionScope = {
  workspaceId: string
  projectionSha: string
}

/** Chunk size for UNWIND batch projection within a kind/predicate group. */
export const PROJECT_CLAIM_BATCH_SIZE = 100

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

const SAFE_CYPHER_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

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

function propsToScalarMap(
  props: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(props)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v
    } else if (v == null) {
      out[k] = ""
    } else {
      out[k] = String(v)
    }
  }
  return out
}

async function loadEntityMapForProjection(
  orgId: string,
  uniqueIds: Set<string>,
): Promise<Map<string, { kind: string; payload: Record<string, unknown> }>> {
  const entityMap = new Map<
    string,
    { kind: string; payload: Record<string, unknown> }
  >()

  if (uniqueIds.size === 0) return entityMap

  const db = getSystemDb()
  const ids = [...uniqueIds]
  const rows = await db
    .select({
      id: objects.id,
      kind: objects.kind,
      payload: objects.payload,
    })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, ids)))

  for (const r of rows) {
    entityMap.set(r.id, {
      kind: r.kind,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    })
  }

  return entityMap
}

export type ProjectionGroupKey = {
  subjectKind: string
  objectKind: string
  predicate: string
}

export type PreparedProjectionRow = {
  claim: ClaimForProjection
  subjectProps: Record<string, unknown>
  objectProps: Record<string, unknown>
}

/** Group claims by Cypher label/edge shape so each batch query has fixed identifiers. */
export function groupClaimsForBatchProjection(
  rows: PreparedProjectionRow[],
): Map<string, PreparedProjectionRow[]> {
  const groups = new Map<string, PreparedProjectionRow[]>()
  for (const row of rows) {
    const key = `${row.claim.subjectKind}\0${row.claim.objectKind}\0${row.claim.predicate}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  return groups
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return []
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function assertSafeCypherIdent(name: string, kind: string): void {
  if (!SAFE_CYPHER_IDENT.test(name)) {
    throw new Error(`Unsafe Cypher ${kind} identifier: ${name}`)
  }
}

function buildUnwindProjectionQuery(
  subjectLabel: string,
  objectLabel: string,
  edgeType: string,
  subjectPropKeys: string[],
  objectPropKeys: string[],
  scope?: GraphProjectionScope | null,
): string {
  assertSafeCypherIdent(subjectLabel, "subject label")
  assertSafeCypherIdent(objectLabel, "object label")
  assertSafeCypherIdent(edgeType, "edge type")
  for (const k of subjectPropKeys) assertSafeCypherIdent(k, "subject prop")
  for (const k of objectPropKeys) assertSafeCypherIdent(k, "object prop")

  const subjectSet = [
    "s.orgId = $orgId",
    ...(scope
      ? ["s.workspaceId = $workspaceId", "s.projectionSha = $projectionSha"]
      : []),
    ...subjectPropKeys.map((k) => `s.${k} = row.subject_${k}`),
  ].join(", ")
  const objectSet = [
    "o.orgId = $orgId",
    ...(scope
      ? ["o.workspaceId = $workspaceId", "o.projectionSha = $projectionSha"]
      : []),
    ...objectPropKeys.map((k) => `o.${k} = row.object_${k}`),
  ].join(", ")

  const mergeKey = scope
    ? "{ id: row.subject_id, orgId: $orgId, workspaceId: $workspaceId }"
    : "{ id: row.subject_id, orgId: $orgId }"
  const mergeObjectKey = scope
    ? "{ id: row.object_id, orgId: $orgId, workspaceId: $workspaceId }"
    : "{ id: row.object_id, orgId: $orgId }"

  return `UNWIND $rows AS row
MERGE (s:${subjectLabel} ${mergeKey})
MERGE (o:${objectLabel} ${mergeObjectKey})
SET ${subjectSet}, ${objectSet}
MERGE (s)-[r:${edgeType}]->(o)
SET r.claim_id = row.claim_id,
    r.status = row.status,
    r.aggregate_confidence = row.aggregate_confidence,
    r.source_count = row.source_count,
    r.last_observed_at = row.last_observed_at,
    r.valid_from = row.valid_from,
    r.valid_to = row.valid_to${scope ? ",\n    r.projectionSha = $projectionSha" : ""}
RETURN count(r) AS projected`
}

function toUnwindRow(
  prepared: PreparedProjectionRow,
): Record<string, string | number | boolean> {
  const subjectScalars = propsToScalarMap(prepared.subjectProps)
  const objectScalars = propsToScalarMap(prepared.objectProps)
  const row: Record<string, string | number | boolean> = {
    subject_id: prepared.claim.subjectId,
    object_id: prepared.claim.objectId,
    claim_id: prepared.claim.id,
    status: prepared.claim.status,
    aggregate_confidence: prepared.claim.aggregatedConfidence,
    source_count: prepared.claim.sourceCount,
    last_observed_at: prepared.claim.lastObservedAt,
    valid_from: prepared.claim.validFrom ?? "",
    valid_to: prepared.claim.validTo ?? "",
  }
  for (const [k, v] of Object.entries(subjectScalars)) {
    row[`subject_${k}`] = v
  }
  for (const [k, v] of Object.entries(objectScalars)) {
    row[`object_${k}`] = v
  }
  return row
}

async function replaceScopedWorkspaceGraph(
  driver: ReturnType<typeof getGraphClient>,
  orgId: string,
  scope?: GraphProjectionScope | null,
): Promise<void> {
  if (!scope) return
  await driver.executeQuery(replaceWorkspaceGraphCypher(), {
    orgId,
    workspaceId: scope.workspaceId,
  })
}

function recordProjectionError(
  errors: string[],
  c: ClaimForProjection,
  err: unknown,
): void {
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
  log.error({
    step: "graphProjection.project_claim",
    message: "projectClaimsFromState: error projecting claim",
    ...details,
  })
  errors.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`)
}

async function projectSingleClaim(
  driver: ReturnType<typeof getGraphClient>,
  orgId: string,
  prepared: PreparedProjectionRow,
  scope?: GraphProjectionScope | null,
): Promise<void> {
  const subjectLabel = prepared.claim.subjectKind
  const objectLabel = prepared.claim.objectKind
  const edgeType = prepared.claim.predicate
  assertSafeCypherIdent(subjectLabel, "subject label")
  assertSafeCypherIdent(objectLabel, "object label")
  assertSafeCypherIdent(edgeType, "edge type")

  const subjectParams = Object.fromEntries(
    Object.entries(prepared.subjectProps).map(([k, v]) => [
      `subject_${k}`,
      v ?? "",
    ]),
  )
  const objectParams = Object.fromEntries(
    Object.entries(prepared.objectProps).map(([k, v]) => [
      `object_${k}`,
      v ?? "",
    ]),
  )

  const subjectSetClauses = [
    "s.orgId = $orgId",
    ...(scope
      ? ["s.workspaceId = $workspaceId", "s.projectionSha = $projectionSha"]
      : []),
    ...Object.keys(prepared.subjectProps).map((k) => `s.${k} = $subject_${k}`),
  ].join(", ")
  const objectSetClauses = [
    "o.orgId = $orgId",
    ...(scope
      ? ["o.workspaceId = $workspaceId", "o.projectionSha = $projectionSha"]
      : []),
    ...Object.keys(prepared.objectProps).map((k) => `o.${k} = $object_${k}`),
  ].join(", ")

  const mergeSubject = scope
    ? "{ id: $subject_id, orgId: $orgId, workspaceId: $workspaceId }"
    : "{ id: $subject_id, orgId: $orgId }"
  const mergeObject = scope
    ? "{ id: $object_id, orgId: $orgId, workspaceId: $workspaceId }"
    : "{ id: $object_id, orgId: $orgId }"

  await driver.executeQuery(
    `MERGE (s:${subjectLabel} ${mergeSubject})
     MERGE (o:${objectLabel} ${mergeObject})
     SET ${subjectSetClauses}, ${objectSetClauses}
     MERGE (s)-[r:${edgeType}]->(o)
     SET r.claim_id = $claimId,
         r.status = $status,
         r.aggregate_confidence = $aggregateConfidence,
         r.source_count = $sourceCount,
         r.last_observed_at = $lastObservedAt,
         r.valid_from = $validFrom,
         r.valid_to = $validTo${scope ? ",\n         r.projectionSha = $projectionSha" : ""}
     RETURN r`,
    {
      subject_id: prepared.claim.subjectId,
      object_id: prepared.claim.objectId,
      orgId,
      ...(scope
        ? {
            workspaceId: scope.workspaceId,
            projectionSha: scope.projectionSha,
          }
        : {}),
      ...subjectParams,
      ...objectParams,
      claimId: prepared.claim.id,
      status: prepared.claim.status,
      aggregateConfidence: prepared.claim.aggregatedConfidence,
      sourceCount: prepared.claim.sourceCount,
      lastObservedAt: prepared.claim.lastObservedAt,
      validFrom: prepared.claim.validFrom,
      validTo: prepared.claim.validTo,
    },
  )
}

/**
 * Projects claims from graph state into FalkorDB.
 * Stores architecture/semantic nodes with enriched properties and predicate-typed edges.
 * Claims project as edges; full provenance remains in Postgres.
 *
 * Batches by (subjectKind, objectKind, predicate) with UNWIND chunks; falls back to
 * per-claim queries if a chunk fails (preserves error accumulation semantics).
 */
export async function projectClaimsFromState(
  claims: ClaimForProjection[],
  scope?: GraphProjectionScope | null,
): Promise<{ projected: number; errors: string[] }> {
  const errors: string[] = []
  let projected = 0
  let skippedInvalidPredicate = 0
  const resolvedOrgId = requireCurrentOrgId()
  const resolvedOrgSlug = requireCurrentOrgSlug()
  const logger = getLogger()
  const startedAt = Date.now()

  if (claims.length === 0) {
    if (scope) {
      await withGraphClient(
        { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
        async () => {
          await replaceScopedWorkspaceGraph(
            getGraphClient(),
            resolvedOrgId,
            scope,
          )
        },
      )
    }
    logger.set({
      step: "graphProjection.summary",
      claimsReceived: 0,
      claimsProjectedToGraph: 0,
      skippedInvalidPredicate: 0,
    })
    logger.info("graph projection replaced (no claims)")
    return { projected: 0, errors: [] }
  }

  const uniqueIds = new Set<string>()
  for (const c of claims) {
    if (isValidGraphEdgeType(c.predicate)) {
      uniqueIds.add(c.subjectId)
      uniqueIds.add(c.objectId)
    }
  }

  const entityMap = await loadEntityMapForProjection(resolvedOrgId, uniqueIds)

  logger.info("projectClaimsFromState: projecting claims to graph", {
    claimCount: claims.length,
  })

  const preparedRows: PreparedProjectionRow[] = []
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
    preparedRows.push({
      claim: c,
      subjectProps: extractNodeProps(
        c.subjectId,
        c.subjectKind,
        subjectEntity?.payload ?? null,
      ),
      objectProps: extractNodeProps(
        c.objectId,
        c.objectKind,
        objectEntity?.payload ?? null,
      ),
    })
  }

  const groups = groupClaimsForBatchProjection(preparedRows)
  let claimsProcessed = 0

  await withGraphClient(
    { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
    async () => {
      const driver = getGraphClient()
      await replaceScopedWorkspaceGraph(driver, resolvedOrgId, scope)

      for (const groupRows of groups.values()) {
        const first = groupRows[0]
        if (!first) continue
        const subjectLabel = first.claim.subjectKind
        const objectLabel = first.claim.objectKind
        const edgeType = first.claim.predicate

        // Union of prop keys across the group so SET clauses stay complete.
        const subjectPropKeys = [
          ...new Set(groupRows.flatMap((r) => Object.keys(r.subjectProps))),
        ]
        const objectPropKeys = [
          ...new Set(groupRows.flatMap((r) => Object.keys(r.objectProps))),
        ]

        for (const chunk of chunkArray(groupRows, PROJECT_CLAIM_BATCH_SIZE)) {
          try {
            const query = buildUnwindProjectionQuery(
              subjectLabel,
              objectLabel,
              edgeType,
              subjectPropKeys,
              objectPropKeys,
              scope,
            )
            const rows = chunk.map((prepared) => {
              const row = toUnwindRow(prepared)
              // Ensure every SET key exists on every row (missing → "").
              for (const k of subjectPropKeys) {
                const key = `subject_${k}`
                if (!(key in row)) row[key] = ""
              }
              for (const k of objectPropKeys) {
                const key = `object_${k}`
                if (!(key in row)) row[key] = ""
              }
              return row
            })
            await driver.executeQuery(query, {
              orgId: resolvedOrgId,
              rows,
              ...(scope
                ? {
                    workspaceId: scope.workspaceId,
                    projectionSha: scope.projectionSha,
                  }
                : {}),
            })
            projected += chunk.length
          } catch (chunkErr) {
            // Preserve per-claim error isolation when a batch fails.
            for (const prepared of chunk) {
              try {
                await projectSingleClaim(driver, resolvedOrgId, prepared, scope)
                projected++
              } catch (err) {
                recordProjectionError(errors, prepared.claim, err)
              }
            }
            log.error({
              step: "graphProjection.batch_fallback",
              message:
                "projectClaimsFromState: batch UNWIND failed; fell back to per-claim",
              error:
                chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
              chunkSize: chunk.length,
              subjectKind: subjectLabel,
              objectKind: objectLabel,
              predicate: edgeType,
            })
          }

          claimsProcessed += chunk.length
          logger.set({
            step: "codeIngestion.project.progress",
            claimsProcessed,
            claimsTotal: preparedRows.length,
            claimsProjectedToGraph: projected,
            projectionErrors: errors.length,
            skippedInvalidPredicate,
            elapsedMs: Date.now() - startedAt,
          })
          logger.info("projectClaimsFromState progress")
          flushWorkflowLog()
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
 * Removes object nodes from FalkorDB when Postgres no longer references them.
 */
export async function deleteObjectsFromGraph(
  objectIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(objectIds.filter(Boolean))]
  if (uniqueIds.length === 0) return

  const resolvedOrgId = requireCurrentOrgId()
  const resolvedOrgSlug = requireCurrentOrgSlug()

  await withGraphClient(
    { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
    async () => {
      const driver = getGraphClient()
      for (const chunk of chunkArray(uniqueIds, PROJECT_CLAIM_BATCH_SIZE)) {
        await driver.executeQuery(
          `UNWIND $ids AS id
           MATCH (n { id: id, orgId: $orgId })
           DETACH DELETE n`,
          { ids: chunk, orgId: resolvedOrgId },
        )
      }
    },
  )
}

/** @deprecated Prefer {@link deleteObjectsFromGraph} for batches. */
export async function deleteObjectFromGraph(objectId: string): Promise<void> {
  await deleteObjectsFromGraph([objectId])
}

/**
 * Removes claim edges from FalkorDB (Postgres remains source of truth).
 */
export async function retractClaimsFromGraph(
  claimIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(claimIds.filter(Boolean))]
  if (uniqueIds.length === 0) return

  const resolvedOrgId = requireCurrentOrgId()
  const resolvedOrgSlug = requireCurrentOrgSlug()

  await withGraphClient(
    { orgId: resolvedOrgId, orgSlug: resolvedOrgSlug },
    async () => {
      const driver = getGraphClient()
      for (const chunk of chunkArray(uniqueIds, PROJECT_CLAIM_BATCH_SIZE)) {
        await driver.executeQuery(
          `UNWIND $claimIds AS claimId
           MATCH (s)-[r]->(o)
           WHERE r.claim_id = claimId AND s.orgId = $orgId AND o.orgId = $orgId
           DELETE r`,
          { claimIds: chunk, orgId: resolvedOrgId },
        )
      }
    },
  )
}

/** @deprecated Prefer {@link retractClaimsFromGraph} for batches. */
export async function retractClaimFromGraph(claimId: string): Promise<void> {
  await retractClaimsFromGraph([claimId])
}

/**
 * Re-projects claims after aggregate or evidence changes (one batched project call).
 */
export async function refreshClaimProjections(
  claimIds: string[],
): Promise<number> {
  const uniqueIds = [...new Set(claimIds.filter(Boolean))]
  if (uniqueIds.length === 0) return 0

  const projectionClaims = await withAmbientOrgDb(async () => {
    const resolvedOrgId = requireCurrentOrgId()
    const db = getOrgDb()
    const subjectRo = aliasedTable(objects, "subject_ro")
    const objectRo = aliasedTable(objects, "object_ro")
    const loaded: ClaimForProjection[] = []

    for (const idChunk of chunkArray(uniqueIds, PROJECT_CLAIM_BATCH_SIZE)) {
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
            inArray(claims.id, idChunk),
            eq(subjectRo.orgId, resolvedOrgId),
            eq(objectRo.orgId, resolvedOrgId),
          ),
        )

      if (rows.length === 0) continue

      const evidenceCounts = Object.fromEntries(
        (
          await db
            .select({
              claimId: claimEvidence.claimId,
              count: sql<number>`count(*)::int`,
            })
            .from(claimEvidence)
            .where(
              inArray(
                claimEvidence.claimId,
                rows.map((r) => r.id),
              ),
            )
            .groupBy(claimEvidence.claimId)
        ).map((r) => [r.claimId, r.count]),
      )

      for (const row of rows) {
        loaded.push({
          id: row.id,
          subjectId: row.subjectId,
          objectId: row.objectId,
          subjectKind: row.subjectKind,
          objectKind: row.objectKind,
          predicate: row.predicate,
          status: row.status,
          aggregatedConfidence: row.aggregatedConfidence,
          sourceCount: evidenceCounts[row.id] ?? 0,
          lastObservedAt: row.lastObservedAt.toISOString(),
          validFrom: row.validFrom?.toISOString() ?? null,
          validTo: row.validTo?.toISOString() ?? null,
        })
      }
    }
    return loaded
  })

  if (projectionClaims.length === 0) return 0
  const result = await projectClaimsFromState(projectionClaims)
  return result.projected
}

/** Re-projects a single claim after aggregate or evidence changes. */
export async function refreshClaimProjection(claimId: string): Promise<void> {
  await refreshClaimProjections([claimId])
}
