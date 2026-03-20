/**
 * Post-processing for identifyInfrastructure – pure logic with no langchain deps.
 * Exported for unit testing deduplication and output shape.
 */

import type { ExtractedClaim, ExtractedObject } from "../schemas.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"

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

type InfraEntry = {
  root: string
  infraType: string
  paths: string[]
  evidences: string[]
}

function mergeEvidence(parts: string[]): string | undefined {
  const unique = [...new Set(parts.map((p) => p.trim()).filter(Boolean))]
  if (unique.length === 0) return undefined
  return unique.join("; ")
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
  const byKey = new Map<string, InfraEntry>()

  for (const inf of capturedInfra) {
    const root = resolveSubmissionRoot(inf.path, roots)
    if (root === null) continue
    const infraType = normalizeInfraType(inf.infraType)
    const dedupKey = `inf:${repositoryId}:${root}:${infraType}`
    const existing = byKey.get(dedupKey)
    if (existing) {
      if (!existing.paths.includes(inf.path)) existing.paths.push(inf.path)
      if (inf.evidence) existing.evidences.push(inf.evidence)
    } else {
      byKey.set(dedupKey, {
        root,
        infraType,
        paths: [inf.path],
        evidences: inf.evidence ? [inf.evidence] : [],
      })
    }
  }

  const extractedObjects: ExtractedObject[] = []
  const extractedClaims: ExtractedClaim[] = []

  for (const [dedupKey, entry] of byKey) {
    const evidence = mergeEvidence(entry.evidences)
    const primaryPath = entry.paths[0] ?? entry.root

    extractedObjects.push({
      kind: "Infrastructure",
      deduplicationKey: dedupKey,
      name: entry.infraType,
      summary: `${entry.infraType} used by ${entry.root}`,
      payload: {
        infra_kind: entry.infraType,
        path: primaryPath,
        ...(entry.paths.length > 1 ? { paths: entry.paths } : {}),
        ...(evidence ? { evidence } : {}),
      },
    })

    extractedClaims.push({
      subjectRef: `svc:${repositoryId}:${entry.root}`,
      subjectKind: "Service",
      objectRef: dedupKey,
      objectKind: "Infrastructure",
      predicate: "RUNS_ON",
      sourceId: `identifyInfrastructure:${repositoryId}:${entry.root}:${entry.infraType}:${targetHash}`,
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.8,
      provenance: { root: entry.root, infraType: entry.infraType, evidence },
    })
  }

  return { extractedObjects, extractedClaims }
}
