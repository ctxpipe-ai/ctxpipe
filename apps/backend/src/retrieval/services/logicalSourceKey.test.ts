import { describe, expect, it } from "vitest"
import { deriveLogicalSourceKey } from "./logicalSourceKey.js"

describe("deriveLogicalSourceKey", () => {
  it("strips trailing :targetHash when present", () => {
    expect(
      deriveLogicalSourceKey(
        "identifyPatterns:repo_abc:./:CQRS:abc123",
        "abc123",
      ),
    ).toBe("identifyPatterns:repo_abc:./:CQRS")
  })

  it("returns sourceId unchanged when suffix does not match targetHash", () => {
    expect(
      deriveLogicalSourceKey(
        "identifyPatterns:repo_abc:./:CQRS:other",
        "abc123",
      ),
    ).toBe("identifyPatterns:repo_abc:./:CQRS:other")
  })

  it("returns sourceId when no trailing colon segment", () => {
    expect(deriveLogicalSourceKey("legacy-source", "abc123")).toBe(
      "legacy-source",
    )
  })

  it("only strips the final :hash segment", () => {
    expect(deriveLogicalSourceKey("a:b:c", "c")).toBe("a:b")
  })
})
