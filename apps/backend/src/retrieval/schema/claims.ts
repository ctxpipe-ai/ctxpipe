import { z } from "zod/v3"

export const SourceType = z.enum([
  "confluence",
  "git",
  "pagerduty",
  "slack",
  "jira",
  "manual",
  "api",
])

export const ExtractionMethod = z.enum([
  "deterministic",
  "llm",
  "imported",
  "manual",
])

export const ClaimStatus = z.enum([
  "active",
  "superseded",
  "disputed",
  "deprecated",
])

export const ClaimSchema = z.object({
  id: z.string().regex(/^claim_[a-z0-9]+$/),
  orgId: z.string(),
  subjectId: z.string(),
  predicate: z.string(),
  objectId: z.string(),
  status: ClaimStatus,
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
  firstObservedAt: z.coerce.date(),
  lastObservedAt: z.coerce.date(),
  aggregatedConfidence: z.number().min(0).max(1),
})

export const ClaimEvidenceSchema = z.object({
  id: z.string().regex(/^ev_[a-z0-9]+$/),
  claimId: z.string(),
  sourceType: SourceType,
  sourceId: z.string(),
  sourceUrl: z.string().url().optional(),
  extractionMethod: ExtractionMethod,
  confidence: z.number().min(0).max(1),
  observedAt: z.coerce.date(),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
  provenance: z.record(z.unknown()).optional(),
})

