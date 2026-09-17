import { sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { claimEvidence } from "../db/schema/claim_evidence.js"
import { claims } from "../db/schema/claims.js"
import { objects } from "../db/schema/objects.js"

/**
 * Graph health as defined in ADR-033. Join density is the north-star metric:
 * the share of objects whose claims carry evidence from at least two distinct
 * extractors (the link pass excluded, since it only derives locations).
 */
export type KnowledgeGraphQuality = {
  totalObjects: number
  totalClaims: number
  /** Objects touched by claims with evidence from ≥ 2 extractors. */
  multiSourceObjects: number
  /** multiSourceObjects / totalObjects (0 when the graph is empty). */
  joinDensity: number
  /** Objects with no claim on either end. */
  orphanObjects: number
  orphanRate: number
  /** Should sit near 1 per extractor once evidence keys dedupe correctly. */
  evidenceRowsPerClaim: number
  /** Legacy `InstructionUnit`s minted from connector Markdown (should be 0 after cleanup). */
  connectorInstructionUnits: number
  kinds: Record<string, number>
  predicates: Record<string, number>
}

const CONNECTOR_PREFIX_PATH_PATTERN =
  "^(github|linear|notion|slack|confluence)/"

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown[] }).rows
  if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : []
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function computeKnowledgeGraphQuality(
  db: Db,
  orgId: string,
): Promise<KnowledgeGraphQuality> {
  const [
    totals,
    kindRows,
    predicateRows,
    multiSource,
    orphans,
    evidence,
    units,
  ] = await Promise.all([
    db.execute(sql`
        SELECT
          (SELECT count(*) FROM ${objects} WHERE ${objects.orgId} = ${orgId}) AS objects,
          (SELECT count(*) FROM ${claims} WHERE ${claims.orgId} = ${orgId}) AS claims
      `),
    db.execute(sql`
        SELECT ${objects.kind} AS kind, count(*) AS c
        FROM ${objects}
        WHERE ${objects.orgId} = ${orgId}
        GROUP BY ${objects.kind}
      `),
    db.execute(sql`
        SELECT ${claims.predicate} AS predicate, count(*) AS c
        FROM ${claims}
        WHERE ${claims.orgId} = ${orgId}
        GROUP BY ${claims.predicate}
      `),
    db.execute(sql`
        WITH touched AS (
          SELECT c.subject_id AS object_id, split_part(ce.source_id, ':', 1) AS extractor
          FROM ${claims} c
          JOIN ${claimEvidence} ce ON ce.claim_id = c.id
          WHERE c.org_id = ${orgId}
          UNION
          SELECT c.object_id AS object_id, split_part(ce.source_id, ':', 1) AS extractor
          FROM ${claims} c
          JOIN ${claimEvidence} ce ON ce.claim_id = c.id
          WHERE c.org_id = ${orgId}
        )
        SELECT count(*) AS c FROM (
          SELECT object_id
          FROM touched
          WHERE extractor <> 'linkLocatedPaths'
          GROUP BY object_id
          HAVING count(DISTINCT extractor) >= 2
        ) multi
      `),
    db.execute(sql`
        SELECT count(*) AS c
        FROM ${objects} o
        WHERE o.org_id = ${orgId}
          AND NOT EXISTS (
            SELECT 1 FROM ${claims} c
            WHERE c.org_id = ${orgId}
              AND (c.subject_id = o.id OR c.object_id = o.id)
          )
      `),
    db.execute(sql`
        SELECT count(*) AS c
        FROM ${claimEvidence} ce
        JOIN ${claims} c ON c.id = ce.claim_id
        WHERE c.org_id = ${orgId}
      `),
    db.execute(sql`
        SELECT count(*) AS c
        FROM ${objects}
        WHERE ${objects.orgId} = ${orgId}
          AND ${objects.kind} = 'InstructionUnit'
          AND ${objects.payload}->>'path' ~ ${CONNECTOR_PREFIX_PATH_PATTERN}
      `),
  ])

  const totalRow = rowsOf(totals)[0] ?? {}
  const totalObjects = num(totalRow.objects)
  const totalClaims = num(totalRow.claims)
  const multiSourceObjects = num(rowsOf(multiSource)[0]?.c)
  const orphanObjects = num(rowsOf(orphans)[0]?.c)
  const evidenceRows = num(rowsOf(evidence)[0]?.c)

  const kinds: Record<string, number> = {}
  for (const row of rowsOf(kindRows)) {
    if (typeof row.kind === "string") kinds[row.kind] = num(row.c)
  }
  const predicates: Record<string, number> = {}
  for (const row of rowsOf(predicateRows)) {
    if (typeof row.predicate === "string")
      predicates[row.predicate] = num(row.c)
  }

  return {
    totalObjects,
    totalClaims,
    multiSourceObjects,
    joinDensity: totalObjects > 0 ? multiSourceObjects / totalObjects : 0,
    orphanObjects,
    orphanRate: totalObjects > 0 ? orphanObjects / totalObjects : 0,
    evidenceRowsPerClaim: totalClaims > 0 ? evidenceRows / totalClaims : 0,
    connectorInstructionUnits: num(rowsOf(units)[0]?.c),
    kinds,
    predicates,
  }
}
