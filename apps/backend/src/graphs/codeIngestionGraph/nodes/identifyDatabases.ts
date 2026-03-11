import {
  codeSearch,
  parseCodeSearchResults,
} from "../../../retrieval/services/codeSearch.js"
import { requireCurrentOrgId } from "../../../auth/context.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"

/** Maps search patterns to actual database type (not client library) */
const DB_PATTERNS: Array<{ query: string; dbType: string }> = [
  { query: "postgresql postgres DATABASE_URL", dbType: "Postgres" },
  { query: "mongodb:// mongo connection", dbType: "Mongo" },
  { query: "redis:// redis client", dbType: "Redis" },
  { query: "mysql:// mysql connection", dbType: "MySQL" },
  { query: "sqlite:// sqlite", dbType: "SQLite" },
]

function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

export async function identifyDatabases(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  const resolvedOrgId = requireCurrentOrgId()
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenDbs = new Set<string>()

  for (const { query, dbType } of DB_PATTERNS) {
    const results = await codeSearch(resolvedOrgId, {
      repositoryIds: [repositoryId],
      query,
    })
    const candidates = parseCodeSearchResults(results)

    for (const root of roots) {
      const hasMatch = candidates.some(
        (c) => c.path && pathMatchesRoot(c.path, root),
      )
      if (!hasMatch) continue

      const dedupKey = `db:${repositoryId}:${root}:${dbType}`
      if (seenDbs.has(dedupKey)) continue
      seenDbs.add(dedupKey)

      const svcDeduplicationKey = `svc:${repositoryId}:${root}`

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
        confidence: 0.85,
        provenance: { root, dbType },
      })
    }
  }

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
