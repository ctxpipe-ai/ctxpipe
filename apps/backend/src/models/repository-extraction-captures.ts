import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { repositoryExtractionCaptures as captures } from "../db/schema/repository_extraction_captures.js"
import type {
  ExtractedClaim,
  ExtractedObject,
} from "../graphs/codeIngestionGraph/schemas.js"

/** One ingestion's capture. A new run with the same key reuses the stored roots. */
export type ExtractionCaptureKey = {
  orgId: string
  repositoryId: string
  sourceSha: string
  scope: string
  extractorVersion: number
}

type RootCapture = {
  extractedObjects: ExtractedObject[]
  extractedClaims: ExtractedClaim[]
}

function matches(key: ExtractionCaptureKey) {
  return and(
    eq(captures.repositoryId, key.repositoryId),
    eq(captures.sourceSha, key.sourceSha),
    eq(captures.scope, key.scope),
    eq(captures.extractorVersion, key.extractorVersion),
  )
}

/** Split values into parts of about 4 MiB of JSON, so no row holds a very large value. */
function splitParts<T>(values: T[]): T[][] {
  const parts: T[][] = [[]]
  let bytes = 0
  for (const value of values) {
    const size = Buffer.byteLength(JSON.stringify(value))
    const current = parts[parts.length - 1] ?? []
    if (current.length && bytes + size > 4 * 1024 * 1024) {
      parts.push([value])
      bytes = size
    } else {
      current.push(value)
      bytes += size
    }
  }
  return parts
}

/**
 * Replace the stored capture of one root. One transaction, so a reader sees
 * all parts or none. Also delete the captures of this organization that are
 * older than seven days, so a failed run that nobody retries leaves no rows.
 */
export async function storeRootCapture(
  key: ExtractionCaptureKey,
  root: string,
  capture: RootCapture,
): Promise<{ objects: number; claims: number }> {
  const parts = [
    ...splitParts(capture.extractedObjects).map((objects) => ({
      objects,
      claims: [] as ExtractedClaim[],
    })),
    ...splitParts(capture.extractedClaims)
      .filter((claims) => claims.length)
      .map((claims) => ({ objects: [] as ExtractedObject[], claims })),
  ]
  await withOrgDbContext(key.orgId, async (db) => {
    await db
      .delete(captures)
      .where(
        or(
          and(matches(key), eq(captures.root, root)),
          and(
            eq(captures.orgId, key.orgId),
            lt(captures.createdAt, sql`now() - interval '7 days'`),
          ),
        ),
      )
    for (const [part, values] of parts.entries())
      await db.insert(captures).values({ ...key, root, part, ...values })
  })
  return {
    objects: capture.extractedObjects.length,
    claims: capture.extractedClaims.length,
  }
}

/** Counts of a stored root capture, or null when the root has no rows. */
export async function storedRootCapture(
  key: ExtractionCaptureKey,
  root: string,
): Promise<{ objects: number; claims: number } | null> {
  const [row] = await withOrgDbContext(key.orgId, (db) =>
    db
      .select({
        parts: sql<number>`count(*)::int`,
        objects: sql<number>`coalesce(sum(jsonb_array_length(${captures.objects})), 0)::int`,
        claims: sql<number>`coalesce(sum(jsonb_array_length(${captures.claims})), 0)::int`,
      })
      .from(captures)
      .where(and(matches(key), eq(captures.root, root))),
  )
  return row?.parts ? { objects: row.objects, claims: row.claims } : null
}

/** All stored values of the roots, in root order. A root without rows is an error. */
export async function loadExtractionCapture(
  key: ExtractionCaptureKey,
  roots: string[],
): Promise<RootCapture> {
  const rows = await withOrgDbContext(key.orgId, (db) =>
    db
      .select({
        root: captures.root,
        objects: captures.objects,
        claims: captures.claims,
      })
      .from(captures)
      .where(and(matches(key), inArray(captures.root, roots)))
      .orderBy(asc(captures.part)),
  )
  const extractedObjects: ExtractedObject[] = []
  const extractedClaims: ExtractedClaim[] = []
  for (const root of roots) {
    const parts = rows.filter((row) => row.root === root)
    if (!parts.length)
      throw new Error(`Extraction capture is missing for root ${root}`)
    for (const part of parts) {
      extractedObjects.push(...(part.objects as ExtractedObject[]))
      extractedClaims.push(...(part.claims as ExtractedClaim[]))
    }
  }
  return { extractedObjects, extractedClaims }
}

/** Delete a capture after its publication succeeds. */
export async function deleteExtractionCapture(
  key: ExtractionCaptureKey,
): Promise<void> {
  await withOrgDbContext(key.orgId, (db) =>
    db.delete(captures).where(matches(key)),
  )
}
