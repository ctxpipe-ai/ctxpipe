import { and, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod/v3"
import { withOrgDbContext } from "../db/client.js"
import { repositoryExtractionCaptures as captures } from "../db/schema/repository_extraction_captures.js"
import {
  type ExtractedCapture,
  ExtractedClaimSchema,
  ExtractedObjectSchema,
} from "../graphs/codeIngestionGraph/schemas.js"

/** One ingestion's capture. A new run with the same key reuses the stored roots. */
export type ExtractionCaptureKey = {
  orgId: string
  repositoryId: string
  sourceSha: string
  scope: string
  extractorVersion: number
}

/** Counts of a stored root capture, with the files its extractors skipped. */
export type ExtractionCounts = {
  objects: number
  claims: number
  skippedFiles: number
}

/** The stored capture of a publishable root cannot be published. */
export class InvalidExtractionCaptureError extends Error {
  override name = "InvalidExtractionCaptureError"
}

// The extractors do not cap every summary, and publication accepts any length.
const storedObjectsSchema = z.array(
  ExtractedObjectSchema.extend({ summary: z.string().optional() }),
)
const storedClaimsSchema = z.array(ExtractedClaimSchema)

function matches(key: ExtractionCaptureKey) {
  return and(
    eq(captures.repositoryId, key.repositoryId),
    eq(captures.sourceSha, key.sourceSha),
    eq(captures.scope, key.scope),
    eq(captures.extractorVersion, key.extractorVersion),
  )
}

/** Replace the stored capture of one root, with the number of files its extractors skipped. */
export async function storeRootCapture(
  key: ExtractionCaptureKey,
  root: string,
  capture: ExtractedCapture,
  skippedFiles: number,
): Promise<ExtractionCounts> {
  const values = {
    objects: capture.extractedObjects,
    claims: capture.extractedClaims,
    skippedFiles,
  }
  await withOrgDbContext(key.orgId, (db) =>
    db
      .insert(captures)
      .values({ ...key, root, ...values })
      .onConflictDoUpdate({
        target: [
          captures.repositoryId,
          captures.sourceSha,
          captures.scope,
          captures.extractorVersion,
          captures.root,
        ],
        set: { ...values, createdAt: sql`now()` },
      }),
  )
  return {
    objects: capture.extractedObjects.length,
    claims: capture.extractedClaims.length,
    skippedFiles,
  }
}

/**
 * Counts of a stored root that a new run can reuse, or null. A root whose
 * extractors skipped files is not reused, so those files get a second try.
 */
export async function storedRootCapture(
  key: ExtractionCaptureKey,
  root: string,
): Promise<ExtractionCounts | null> {
  const [row] = await withOrgDbContext(key.orgId, (db) =>
    db
      .select({
        objects: sql<number>`jsonb_array_length(${captures.objects})`,
        claims: sql<number>`jsonb_array_length(${captures.claims})`,
        skippedFiles: captures.skippedFiles,
      })
      .from(captures)
      .where(
        and(
          matches(key),
          eq(captures.root, root),
          eq(captures.skippedFiles, 0),
        ),
      ),
  )
  return row ?? null
}

/**
 * All stored values of the roots, in root order. A root without a row, or a
 * row that does not parse, is an error.
 */
export async function loadExtractionCapture(
  key: ExtractionCaptureKey,
  roots: string[],
): Promise<ExtractedCapture> {
  const rows = await withOrgDbContext(key.orgId, (db) =>
    db
      .select({
        root: captures.root,
        objects: captures.objects,
        claims: captures.claims,
      })
      .from(captures)
      .where(and(matches(key), inArray(captures.root, roots))),
  )
  const capture: ExtractedCapture = {
    extractedObjects: [],
    extractedClaims: [],
  }
  for (const root of roots) {
    const row = rows.find((candidate) => candidate.root === root)
    if (!row) throw new Error(`Extraction capture is missing for root ${root}`)
    const objects = storedObjectsSchema.safeParse(row.objects)
    const claims = storedClaimsSchema.safeParse(row.claims)
    if (!objects.success || !claims.success)
      throw new InvalidExtractionCaptureError(
        `Extraction capture of root ${root} is invalid: ${(objects.error ?? claims.error)?.issues[0]?.message}`,
      )
    capture.extractedObjects.push(...objects.data)
    capture.extractedClaims.push(...claims.data)
  }
  return capture
}

/** Delete one key's capture, so the next run extracts it again. */
export async function deleteExtractionCapture(
  key: ExtractionCaptureKey,
): Promise<void> {
  await withOrgDbContext(key.orgId, (db) =>
    db.delete(captures).where(matches(key)),
  )
}

/**
 * Delete every capture of a repository after a publication succeeds: each
 * source SHA and scope, also those of failed runs that nobody retried.
 * Ingestion runs one at a time per repository: `repository_ingestion_requests`
 * holds one current request, and `prepareRepositoryIngestionRequest` replaces
 * it only after its run ends or when the binding changes. A superseded run
 * that still runs fails at `assertRepositoryIngestionRequest` and never
 * publishes, so no run that can publish still needs these rows. A repository
 * delete removes its rows through the foreign key.
 */
export async function deleteRepositoryExtractionCaptures(
  orgId: string,
  repositoryId: string,
): Promise<void> {
  await withOrgDbContext(orgId, (db) =>
    db.delete(captures).where(eq(captures.repositoryId, repositoryId)),
  )
}
