/**
 * Pure post-processing for identifyAPIClients. Isolated to avoid pulling in
 * auth/db deps when testing.
 */
import type { ExtractedClaim, ExtractedObject } from "../schemas.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"

export type SubmittedApiClient = {
  path: string
  consumedApi?: string
  consumedApiName?: string
  consumedApiUrl?: string
  evidence?: string
}

/** Post-process captured API clients into objects and claims. */
export function processApiClients(
  capturedClients: SubmittedApiClient[],
  repositoryId: string,
  roots: string[],
  targetHash: string,
): { objects: ExtractedObject[]; claims: ExtractedClaim[] } {
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenExternalKeys = new Set<string>()

  for (const client of capturedClients) {
    const root = resolveSubmissionRoot(client.path, roots)
    if (root === null) continue

    const svcDeduplicationKey = `svc:${repositoryId}:${root}`

    if (client.consumedApi) {
      const apiKey = `api:${repositoryId}:${root}:${client.consumedApi}`
      claims.push({
        subjectRef: svcDeduplicationKey,
        subjectKind: "Service",
        objectRef: apiKey,
        objectKind: "API",
        predicate: "CONSUMES_API",
        sourceId: `identifyAPIClients:${repositoryId}:${root}:${client.consumedApi}:${targetHash}`,
        sourceType: "git",
        extractionMethod: "llm",
        confidence: 0.8,
        provenance: {
          path: client.path,
          consumedApi: client.consumedApi,
          evidence: client.evidence,
        },
      })
    } else if (client.consumedApiName) {
      const name = client.consumedApiName.trim()
      if (!name) continue
      const dedupKey = `api:${repositoryId}:${root}:external:${name}`
      if (!seenExternalKeys.has(dedupKey)) {
        seenExternalKeys.add(dedupKey)
        objects.push({
          kind: "API",
          deduplicationKey: dedupKey,
          name,
          summary: `External API: ${name} consumed by ${root}`,
          payload: {
            external: true,
            consumedApiUrl: client.consumedApiUrl,
          },
        })
      }
      claims.push({
        subjectRef: svcDeduplicationKey,
        subjectKind: "Service",
        objectRef: dedupKey,
        objectKind: "API",
        predicate: "CONSUMES_API",
        sourceId: `identifyAPIClients:${repositoryId}:${root}:external:${name}:${targetHash}`,
        sourceType: "git",
        extractionMethod: "llm",
        confidence: 0.8,
        provenance: {
          path: client.path,
          consumedApiName: name,
          consumedApiUrl: client.consumedApiUrl,
          evidence: client.evidence,
        },
      })
    }
  }

  return { objects, claims }
}
