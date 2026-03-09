import type { z } from "zod/v3"
import type { ExtractionMethod, SourceType } from "../schema/claims.js"

type SourceTypeValue = z.infer<typeof SourceType>
type ExtractionMethodValue = z.infer<typeof ExtractionMethod>

export type EvidenceInput = {
  sourceType: SourceTypeValue
  extractionMethod: ExtractionMethodValue
  confidence: number
  observedAt: Date
}

/** Weights for source reliability (higher = more trusted) */
const SOURCE_WEIGHTS: Record<SourceTypeValue, number> = {
  git: 1.0,
  confluence: 0.9,
  manual: 0.95,
  pagerduty: 0.85,
  slack: 0.7,
  jira: 0.85,
  api: 0.8,
}

/** Weights for extraction method reliability */
const METHOD_WEIGHTS: Record<ExtractionMethodValue, number> = {
  deterministic: 1.0,
  manual: 0.95,
  imported: 0.85,
  llm: 0.7,
}

/** Default half-life in days for recency decay (evidence older than this loses weight) */
const RECENCY_HALF_LIFE_DAYS = 90

/**
 * Computes aggregated confidence from evidence.
 * Uses weighted sum with source/method weights and optional recency decay.
 * Avoids simple averaging; supports future Bayesian upgrade.
 */
export function aggregateConfidence(
  evidence: EvidenceInput[],
  options?: {
    /** Reference date for recency (default: now) */
    referenceDate?: Date
    /** Half-life in days for recency decay; 0 = no decay */
    recencyHalfLifeDays?: number
  },
): number {
  if (evidence.length === 0) return 0

  const refDate = options?.referenceDate ?? new Date()
  const halfLifeDays = options?.recencyHalfLifeDays ?? RECENCY_HALF_LIFE_DAYS

  let weightedSum = 0
  let totalWeight = 0

  for (const e of evidence) {
    const sourceW = SOURCE_WEIGHTS[e.sourceType] ?? 0.5
    const methodW = METHOD_WEIGHTS[e.extractionMethod] ?? 0.5
    const baseWeight = sourceW * methodW

    let recencyW = 1
    if (halfLifeDays > 0) {
      const ageDays =
        (refDate.getTime() - new Date(e.observedAt).getTime()) /
        (1000 * 60 * 60 * 24)
      recencyW = 0.5 ** (ageDays / halfLifeDays)
    }

    const weight = baseWeight * recencyW
    weightedSum += e.confidence * weight
    totalWeight += weight
  }

  if (totalWeight === 0) return 0
  const raw = weightedSum / totalWeight
  return Math.min(1, Math.max(0, raw))
}
