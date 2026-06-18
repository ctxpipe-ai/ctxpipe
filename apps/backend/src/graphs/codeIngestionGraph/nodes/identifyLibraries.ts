/**
 * identifyLibraries extractor
 *
 * Detects architectural libraries (ORM, HTTP client, auth, validation, etc.) used by
 * services in a repository by scanning package manifests and dependency files.
 * Produces Library objects and USES_LIBRARY claims (Service → Library).
 */

import { requireCurrentOrgId } from "../../../auth/context.js"
import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import {
  collectDeterministicScanPaths,
  manifestPaths,
  scanLibraries,
} from "./deterministicRepoScan.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

/** Normalize library name to canonical form for deduplication */
export function normalizeLibraryName(name: string): string {
  const lower = name.toLowerCase()
  const known: Record<string, string> = {
    prisma: "Prisma",
    drizzle: "Drizzle",
    "drizzle-orm": "Drizzle",
    express: "Express",
    hono: "Hono",
    zod: "Zod",
    "better-auth": "Better Auth",
    ioredis: "ioredis",
    "next.js": "Next.js",
    next: "Next.js",
    fastify: "Fastify",
    "fast-api": "FastAPI",
    fastapi: "FastAPI",
    flask: "Flask",
    django: "Django",
    trpc: "tRPC",
    "@trpc/server": "tRPC",
    axios: "Axios",
    fetch: "fetch",
    "react-query": "TanStack Query",
    "tanstack-query": "TanStack Query",
    "@tanstack/react-query": "TanStack Query",
    mongoose: "Mongoose",
    typeorm: "TypeORM",
    knex: "Knex",
    sequelize: "Sequelize",
    "better-sqlite3": "better-sqlite3",
    redis: "Redis",
    "@upstash/redis": "Upstash Redis",
    supabase: "Supabase",
    "@supabase/supabase-js": "Supabase",
  }
  return known[lower] ?? name
}

type SubmittedLibrary = {
  name: string
  path: string
  category?: string
  evidence?: string
}

export async function identifyLibraries(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, orgId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()

  if (shouldSkipExtractorForPartialDeletesOnly(state)) {
    return {}
  }

  const scanPaths = partialScanPathsForExtractors(state)
  const allPaths = await listFilesRecursive(repositoryId, orgId)
  const scopedPaths =
    scanPaths.length > 0
      ? filterPathsByPartialScan(allPaths, scanPaths)
      : allPaths

  const pathsToFetch = collectDeterministicScanPaths(allPaths, scanPaths)
  const contents = await fetchFiles(repositoryId, orgId, pathsToFetch)
  const scopedManifests = manifestPaths(scopedPaths)

  let submissions = scanLibraries(scopedManifests, contents).map((lib) => ({
    name: lib.name,
    path: lib.path,
    category: lib.category,
    evidence: lib.evidence,
  }))

  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((lib) =>
      repoPathMatchesPartialScan(lib.path, scanPaths),
    )
  }

  const { objects: postObjects, claims: postClaims } = postProcessLibraries(
    submissions,
    { repositoryId, roots, targetHash, extractionMethod: "deterministic" },
  )

  return {
    extractedObjects: postObjects,
    extractedClaims: postClaims,
  }
}

/** Post-process captured libraries into objects and claims. Exported for testing. */
export function postProcessLibraries(
  capturedLibraries: SubmittedLibrary[],
  state: Pick<CodeIngestionState, "repositoryId" | "roots" | "targetHash"> & {
    extractionMethod?: "deterministic" | "llm"
  },
): { objects: ExtractedObject[]; claims: ExtractedClaim[] } {
  const {
    repositoryId,
    roots = ["./"],
    targetHash,
    extractionMethod = "llm",
  } = state
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenLibs = new Set<string>()

  for (const lib of capturedLibraries) {
    const root = resolveSubmissionRoot(lib.path, roots)
    if (root === null) continue
    const libraryName = normalizeLibraryName(lib.name)
    const dedupKey = `lib:${repositoryId}:${root}:${libraryName}`
    if (seenLibs.has(dedupKey)) continue
    seenLibs.add(dedupKey)

    const svcDeduplicationKey = `svc:${repositoryId}:${root}`

    objects.push({
      kind: "Library",
      deduplicationKey: dedupKey,
      name: libraryName,
      summary: `${libraryName} used by ${root}${lib.category ? ` (${lib.category})` : ""}`,
      payload: lib.category ? { category: lib.category } : undefined,
    })

    claims.push({
      subjectRef: svcDeduplicationKey,
      subjectKind: "Service",
      objectRef: dedupKey,
      objectKind: "Library",
      predicate: "USES_LIBRARY",
      sourceId: `identifyLibraries:${repositoryId}:${root}:${libraryName}:${targetHash}`,
      sourceType: "git",
      extractionMethod,
      confidence: extractionMethod === "deterministic" ? 0.9 : 0.8,
      provenance: {
        root,
        libraryName,
        category: lib.category,
        evidence: lib.evidence,
      },
    })
  }

  return { objects, claims }
}
