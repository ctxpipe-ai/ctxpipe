import { describe, expect, it } from "vitest"
import {
  evidenceKeyMatchesPathSegment,
  normalizeGitPath,
  replaceAllQuotedPathSegments,
  replaceFirstOccurrence,
} from "./ingestionPathMatching.js"

describe("normalizeGitPath", () => {
  it("uses forward slashes and strips ./", () => {
    expect(normalizeGitPath(".\\foo\\bar")).toBe("foo/bar")
    expect(normalizeGitPath("./src/a.ts")).toBe("src/a.ts")
  })
})

describe("evidenceKeyMatchesPathSegment", () => {
  it("matches a full colon segment and avoids partial collisions", () => {
    const key = "identifyAPIs:repo_1:./:src/foo.ts:abc123"
    expect(evidenceKeyMatchesPathSegment("src/foo.ts", key)).toBe(true)
    expect(evidenceKeyMatchesPathSegment("src/foo", key)).toBe(false)
    expect(evidenceKeyMatchesPathSegment("foo.ts", key)).toBe(false)
  })
})

describe("replaceFirstOccurrence", () => {
  it("replaces only the first occurrence", () => {
    expect(replaceFirstOccurrence("a:b:a", "a", "X")).toBe("X:b:a")
  })
})

describe("replaceAllQuotedPathSegments", () => {
  it("replaces every occurrence of the from segment (mirrors regexp_replace … 'g')", () => {
    const key =
      "identifyPatterns:repo_1:./:old/old:hash1:extra:identifyPatterns:repo_1:./:old/old:hash2"
    const from = "old/old"
    const to = "new/new"
    expect(replaceAllQuotedPathSegments(key, from, to)).toBe(
      "identifyPatterns:repo_1:./:new/new:hash1:extra:identifyPatterns:repo_1:./:new/new:hash2",
    )
  })

  it("treats regex metacharacters as literals", () => {
    expect(replaceAllQuotedPathSegments("a.b.c.a.b", "a.b", "x")).toBe("x.c.x")
  })
})
