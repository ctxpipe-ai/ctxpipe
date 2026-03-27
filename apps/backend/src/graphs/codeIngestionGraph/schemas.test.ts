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

describe("CodeIngestionStateSchema", () => {
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
