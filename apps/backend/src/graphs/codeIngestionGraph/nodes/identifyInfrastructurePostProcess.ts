/**
 * Post-processing for identifyInfrastructure – pure logic with no langchain deps.
 * Exported for unit testing deduplication and output shape.
 */

import type { ExtractedClaim, ExtractedObject } from "../schemas.js"

function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

/** Normalize infraType to canonical form for deduplication */
export function normalizeInfraType(infraType: string): string {
  const lower = infraType.toLowerCase()
  if (lower.includes("docker") && lower.includes("compose")) return "Docker Compose"
  if (lower.includes("docker")) return "Docker"
  if (lower.includes("kubernetes") || lower.includes("k8s")) return "Kubernetes"
  if (lower.includes("helm")) return "Helm"
  if (lower.includes("serverless")) return "Serverless"
  if (lower.includes("lambda")) return "Lambda"
  if (lower.includes("cloud run")) return "Cloud Run"
  if (lower.includes("terraform")) return "Terraform"
  if (lower.includes("pulumi")) return "Pulumi"
  if (lower.includes("cloudflare") && lower.includes("worker")) return "Cloudflare Workers"
  if (lower.includes("vercel")) return "Vercel"
  if (lower.includes("fly.io") || lower.includes("fly io")) return "Fly.io"
  if (lower.includes("railway")) return "Railway"
  if (lower.includes("render")) return "Render"
  return infraType
}

export type SubmittedInfrastructure = {
  infraType: string
  path: string
  evidence?: string
}

/**
 * Process captured infrastructure into extracted objects and claims.
 */
export function processCapturedInfrastructure(
  capturedInfra: SubmittedInfrastructure[],
  repositoryId: string,
  roots: string[],
  targetHash: string,
): { extractedObjects: ExtractedObject[]; extractedClaims: ExtractedClaim[] } {
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenInfra = new Set<string>()

  for (const root of roots) {
    const svcDeduplicationKey = `svc:${repositoryId}:${root}`
    for (const inf of capturedInfra) {
      if (!pathMatchesRoot(inf.path, root)) continue
      const infraType = normalizeInfraType(inf.infraType)
      const dedupKey = `inf:${repositoryId}:${root}:${infraType}`
      if (seenInfra.has(dedupKey)) continue
      seenInfra.add(dedupKey)

      objects.push({
        kind: "Infrastructure",
        deduplicationKey: dedupKey,
        name: infraType,
        summary: `${infraType} used by ${root}`,
        payload: {
          infra_kind: infraType,
          path: inf.path,
          evidence: inf.evidence,
        },
      })

      claims.push({
        subjectRef: svcDeduplicationKey,
        subjectKind: "Service",
        objectRef: dedupKey,
        objectKind: "Infrastructure",
        predicate: "RUNS_ON",
        sourceId: `identifyInfrastructure:${repositoryId}:${root}:${infraType}:${targetHash}`,
        sourceType: "git",
        extractionMethod: "llm",
        confidence: 0.8,
        provenance: { root, infraType, evidence: inf.evidence },
      })
    }
  }

  return { extractedObjects: objects, extractedClaims: claims }
}
