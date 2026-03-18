/**
 * Pure post-processing for identifyStreams. No langchain imports.
 * Exported for testing deduplication and role→predicate mapping.
 */

import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"

function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

/** Normalize streamType to canonical form for deduplication */
function normalizeStreamType(streamType: string): string {
  const lower = streamType.toLowerCase()
  if (lower.includes("kafka")) return "Kafka"
  if (lower.includes("rabbit")) return "RabbitMQ"
  if (lower.includes("sqs")) return "SQS"
  if (lower.includes("sns")) return "SNS"
  if (lower.includes("redis") && (lower.includes("pub") || lower.includes("sub"))) return "Redis Pub/Sub"
  if (lower.includes("redis")) return "Redis"
  if (lower.includes("nats")) return "NATS"
  if (lower.includes("pulsar")) return "Pulsar"
  if (lower.includes("google pub") || lower.includes("pubsub")) return "Google Pub/Sub"
  if (lower.includes("azure") && lower.includes("event")) return "Azure Event Hubs"
  if (lower.includes("activemq")) return "ActiveMQ"
  return streamType
}

export type SubmittedStream = {
  streamType: string
  path: string
  role: "producer" | "consumer" | "both"
  evidence?: string
}

/**
 * Post-process submitted streams into ExtractedObjects and ExtractedClaims.
 */
export function processStreamSubmissions(
  capturedStreams: SubmittedStream[],
  state: Pick<CodeIngestionState, "repositoryId" | "roots" | "targetHash">,
): { objects: ExtractedObject[]; claims: ExtractedClaim[] } {
  const { repositoryId, roots = ["./"], targetHash } = state
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []

  type StreamEntry = { root: string; streamType: string; evidence?: string; hasProducer: boolean; hasConsumer: boolean }
  const byKey = new Map<string, StreamEntry>()

  for (const root of roots) {
    for (const s of capturedStreams) {
      if (!pathMatchesRoot(s.path, root)) continue
      const streamType = normalizeStreamType(s.streamType)
      const dedupKey = `stream:${repositoryId}:${root}:${streamType}`
      const existing = byKey.get(dedupKey)
      const hasProducer = s.role === "producer" || s.role === "both"
      const hasConsumer = s.role === "consumer" || s.role === "both"
      if (existing) {
        existing.hasProducer = existing.hasProducer || hasProducer
        existing.hasConsumer = existing.hasConsumer || hasConsumer
        if (s.evidence && !existing.evidence) existing.evidence = s.evidence
      } else {
        byKey.set(dedupKey, {
          root,
          streamType,
          evidence: s.evidence,
          hasProducer,
          hasConsumer,
        })
      }
    }
  }

  for (const [dedupKey, entry] of byKey) {
    const svcDeduplicationKey = `svc:${repositoryId}:${entry.root}`

    objects.push({
      kind: "Stream",
      deduplicationKey: dedupKey,
      name: entry.streamType,
      summary: `${entry.streamType} used by ${entry.root}`,
      payload: { streamType: entry.streamType, path: entry.root, evidence: entry.evidence },
    })

    const predicates: Array<"PRODUCES_TO" | "CONSUMES_FROM"> = []
    if (entry.hasProducer) predicates.push("PRODUCES_TO")
    if (entry.hasConsumer) predicates.push("CONSUMES_FROM")

    for (const predicate of predicates) {
      claims.push({
        subjectRef: svcDeduplicationKey,
        subjectKind: "Service",
        objectRef: dedupKey,
        objectKind: "Stream",
        predicate,
        sourceId: `identifyStreams:${repositoryId}:${entry.root}:${entry.streamType}:${predicate}:${targetHash}`,
        sourceType: "git",
        extractionMethod: "llm",
        confidence: 0.8,
        provenance: { root: entry.root, streamType: entry.streamType, evidence: entry.evidence },
      })
    }
  }

  return { objects, claims }
}
