import { describe, expect, it } from "vitest"
import { extractionSubgraph } from "./extractionSubgraph.js"

describe("extractionSubgraph", () => {
  it("exports extractedObjects and extractedClaims to the parent graph", () => {
    const outputChannels = extractionSubgraph.outputChannels
    expect(outputChannels).toEqual(
      expect.arrayContaining(["extractedObjects", "extractedClaims"]),
    )
  })
})
