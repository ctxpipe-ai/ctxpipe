import { and, eq, inArray, lt, or, sql } from "drizzle-orm"
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

const REPO_ROOT_ROW_SUFFIX = "#repo-root"

/**
 * Row name of a root. The root that reads the repo-root instruction files has
 * a row name of its own. Thus a run with a different root set cannot reuse
 * that row for a root that must skip those files.
 */
export function captureRowRoot(
  root: string,
  ownsRepoRootInstructions: boolean,
): string {
  return ownsRepoRootInstructions ? `${root}${REPO_ROOT_ROW_SUFFIX}` : root
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
 * All stored values of the roots (row names), in root order. A root without a
 * row, or a row that does not parse, is an error. A run that started before
 * the `#repo-root` row name stored that root under its plain name, so the
 * loader also reads the plain name.
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
      .where(
        and(
          matches(key),
          inArray(captures.root, [...roots, ...roots.map(plainRowRoot)]),
        ),
      ),
  )
  const capture: ExtractedCapture = {
    extractedObjects: [],
    extractedClaims: [],
  }
  for (const root of roots) {
    const row =
      rows.find((candidate) => candidate.root === root) ??
      rows.find((candidate) => candidate.root === plainRowRoot(root))
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

function plainRowRoot(root: string): string {
  return root.endsWith(REPO_ROOT_ROW_SUFFIX)
    ? root.slice(0, -REPO_ROOT_ROW_SUFFIX.length)
    : root
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
 * Delete the captures of a repository after a publication succeeds: the rows
 * of the publishing run's key, and each row stored before that run started
 * (other source SHAs and scopes, also those of failed runs that nobody
 * retried). Ingestion runs one at a time per repository, but a run can wait
 * for write access for a long time after its request check. When the target
 * branch changes in that time, a new run starts and stores its roots. Those
 * rows are newer than the waiting run's start and have a different key, so
 * the waiting run's publish keeps them. `storeRootCapture` resets `created_at`
 * when it replaces a row. A repository delete removes the rows through the
 * foreign key.
 */
export async function deleteRepositoryExtractionCaptures(
  key: ExtractionCaptureKey,
  runStartedAt: Date,
): Promise<void> {
  await withOrgDbContext(key.orgId, (db) =>
    db
      .delete(captures)
      .where(
        and(
          eq(captures.repositoryId, key.repositoryId),
          or(matches(key), lt(captures.createdAt, runStartedAt)),
        ),
      ),
  )
}
