import { describe, expect, it } from "vitest"
import {
  evidenceKeyMatchesPathSegment,
  evidenceSourceIdMayHaveWindowsDriveColon,
  normalizeGitPath,
  renamePathSegmentInColonDelimitedKey,
  replaceAllQuotedPathSegments,
} from "./ingestionPathMatching.js"

function replaceFirstSubstringOccurrence(
  value: string,
  from: string,
  to: string,
): string {
  if (from.length === 0) return value
  const idx = value.indexOf(from)
  if (idx === -1) return value
  return value.slice(0, idx) + to + value.slice(idx + from.length)
}

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

describe("replaceFirstSubstringOccurrence (test helper)", () => {
  it("replaces only the first occurrence", () => {
    expect(replaceFirstSubstringOccurrence("a:b:a", "a", "X")).toBe("X:b:a")
  })
})

describe("evidenceSourceIdMayHaveWindowsDriveColon", () => {
  it("detects Windows-style drive segments", () => {
    expect(
      evidenceSourceIdMayHaveWindowsDriveColon("x:repo:C:\\foo\\bar.ts:hash"),
    ).toBe(true)
    expect(
      evidenceSourceIdMayHaveWindowsDriveColon("identifyAPIs:repo_1:./:src/a.ts:h"),
    ).toBe(false)
  })
})

describe("renamePathSegmentInColonDelimitedKey", () => {
  it("replaces only full segments (mirrors Postgres segment regexp_replace)", () => {
    const key =
      "identifyPatterns:repo_1:./:old/old:hash1:extra:identifyPatterns:repo_1:./:old/old:hash2"
    expect(
      renamePathSegmentInColonDelimitedKey(key, "old/old", "new/new"),
    ).toBe(
      "identifyPatterns:repo_1:./:new/new:hash1:extra:identifyPatterns:repo_1:./:new/new:hash2",
    )
  })

  it("does not rename a longer segment that merely contains the path as a substring", () => {
    const key = "identifyAPIs:repo:src/a.ts:hash"
    expect(renamePathSegmentInColonDelimitedKey(key, "src/a", "src/b")).toBe(
      key,
    )
  })
})

describe("replaceAllQuotedPathSegments", () => {
  it("delegates to segment rename", () => {
    expect(replaceAllQuotedPathSegments("a.b:c:a.b", "a.b", "x")).toBe("x:c:x")
  })
})
