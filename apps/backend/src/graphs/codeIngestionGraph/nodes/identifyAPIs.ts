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

function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

export async function identifyAPIs(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  const resolvedOrgId = requireCurrentOrgId()
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []

  const results = await codeSearch(resolvedOrgId, {
    repositoryIds: [repositoryId],
    query: "openapi OR swagger OR trpc OR grpc",
  })
  const candidates = parseCodeSearchResults(results)

  for (const root of roots) {
    const seenPaths = new Set<string>()
    for (const c of candidates) {
      const path = c.path ?? ""
      if (!path || !pathMatchesRoot(path, root)) continue
      if (seenPaths.has(path)) continue
      seenPaths.add(path)

      const name = path.split("/").pop() ?? "api"
      const deduplicationKey = `api:${repositoryId}:${root}:${path}`

      objects.push({
        type: "API",
        deduplicationKey,
        name,
        summary: `API at ${path}`,
      })

      const svcDeduplicationKey = `svc:${repositoryId}:${root}`
      claims.push({
        subjectRef: svcDeduplicationKey,
        predicate: "EXPOSES_API",
        objectRef: deduplicationKey,
        sourceId: `identifyAPIs:${repositoryId}:${root}:${path}:${targetHash}`,
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.8,
        provenance: { path, root },
      })
    }
  }

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
