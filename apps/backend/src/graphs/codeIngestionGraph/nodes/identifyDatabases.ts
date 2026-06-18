/**
 * identifyDatabases – Detects databases used by services via Prisma schemas,
 * docker-compose services, and manifest dependencies.
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
  scanDatabases,
} from "./deterministicRepoScan.js"
import {
  filterPathsByPartialScan,
  partialScanPathsForExtractors,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

/** Normalize dbType to canonical form for deduplication */
function normalizeDbType(dbType: string): string {
  const lower = dbType.toLowerCase()
  if (lower.includes("postgres") || lower === "pg") return "Postgres"
  if (lower.includes("mysql")) return "MySQL"
  if (lower.includes("sqlite")) return "SQLite"
  if (lower.includes("mongo")) return "Mongo"
  if (lower.includes("redis")) return "Redis"
  if (lower.includes("dynamo")) return "DynamoDB"
  if (lower.includes("supabase")) return "Supabase"
  if (lower.includes("cassandra")) return "Cassandra"
  if (lower.includes("cockroach")) return "CockroachDB"
  return dbType
}

export async function identifyDatabases(
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

  let submissions = scanDatabases(scopedPaths, contents)

  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((db) =>
      repoPathMatchesPartialScan(db.path, scanPaths),
    )
  }

  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenDbs = new Set<string>()

  for (const root of roots) {
    const svcDeduplicationKey = `svc:${repositoryId}:${root}`
    for (const db of submissions) {
      if (!pathMatchesRoot(db.path, root)) continue
      const dbType = normalizeDbType(db.dbType)
      const dedupKey = `db:${repositoryId}:${root}:${dbType}`
      if (seenDbs.has(dedupKey)) continue
      seenDbs.add(dedupKey)

      objects.push({
        kind: "Database",
        deduplicationKey: dedupKey,
        name: dbType,
        summary: `${dbType} used by ${root}`,
      })

      claims.push({
        subjectRef: svcDeduplicationKey,
        subjectKind: "Service",
        objectRef: dedupKey,
        objectKind: "Database",
        predicate: "DEPENDS_ON",
        sourceId: `identifyDatabases:${repositoryId}:${root}:${dbType}:${targetHash}`,
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.9,
        provenance: { root, dbType, evidence: db.evidence },
      })
    }
  }

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
