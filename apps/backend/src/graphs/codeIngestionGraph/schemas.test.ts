import { describe, expect, it } from "vitest"
import "@langchain/langgraph/zod"
import { schemaMetaRegistry } from "@langchain/langgraph/zod"
import { CodeIngestionStateSchema } from "./schemas.js"

const sampleClaim = {
  id: "claim_1",
  subjectId: "svc_1",
  objectId: "inu_1",
  subjectKind: "Service",
  objectKind: "InstructionUnit",
  predicate: "HAS_INSTRUCTION",
  status: "active",
  aggregatedConfidence: 0.9,
  sourceCount: 1,
  lastObservedAt: "2025-01-01T00:00:00.000Z",
  validFrom: null,
  validTo: null,
} as const

const sampleExtractedObject = {
  kind: "Service" as const,
  deduplicationKey: "svc:backend",
  name: "backend",
} as const

const sampleExtractedClaim = {
  subjectRef: "svc:backend",
  subjectKind: "Service",
  objectRef: "inu:readme",
  objectKind: "InstructionUnit",
  predicate: "HAS_INSTRUCTION",
  sourceId: "repo_1",
  sourceType: "repository" as const,
  extractionMethod: "llm" as const,
  confidence: 0.9,
} as const

describe("CodeIngestionStateSchema", () => {
  it("concat-merges extractedObjects across parallel branch updates", () => {
    const channels = schemaMetaRegistry.getChannelsForSchema(
      CodeIngestionStateSchema,
    )
    const ch = channels.extractedObjects
    ch.update([
      [sampleExtractedObject],
      [{ ...sampleExtractedObject, deduplicationKey: "svc:ui" }],
    ])
    const merged = ch.get()
    expect(merged).toHaveLength(2)
    expect(merged.map((o) => o.deduplicationKey)).toEqual([
      "svc:backend",
      "svc:ui",
    ])
  })

  it("concat-merges extractedClaims across parallel branch updates", () => {
    const channels = schemaMetaRegistry.getChannelsForSchema(
      CodeIngestionStateSchema,
    )
    const ch = channels.extractedClaims
    ch.update([
      [sampleExtractedClaim],
      [{ ...sampleExtractedClaim, objectRef: "inu:setup" }],
    ])
    const merged = ch.get()
    expect(merged).toHaveLength(2)
    expect(merged.map((c) => c.objectRef)).toEqual([
      "inu:readme",
      "inu:setup",
    ])
  })

  it("concat-merges claimsForProjection across parallel branch updates", () => {
    const channels = schemaMetaRegistry.getChannelsForSchema(
      CodeIngestionStateSchema,
    )
    const ch = channels.claimsForProjection
    ch.update([
      [sampleClaim],
      [{ ...sampleClaim, id: "claim_2" }],
    ])
    const merged = ch.get()
    expect(merged).toHaveLength(2)
    expect(merged.map((c) => c.id)).toEqual(["claim_1", "claim_2"])
  })
})
