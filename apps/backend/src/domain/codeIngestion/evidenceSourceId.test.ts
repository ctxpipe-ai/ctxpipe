import { describe, expect, it } from "vitest"
import { deriveLogicalSourceKey } from "../../retrieval/services/logicalSourceKey.js"
import {
  buildEvidenceSourceId,
  isConventionalEvidenceSourceId,
} from "./evidenceSourceId.js"

describe("buildEvidenceSourceId", () => {
  it("puts the repository id second and the target hash last", () => {
    const id = buildEvidenceSourceId({
      extractor: "githubPull",
      repositoryId: "repo_ctx",
      segments: [
        "repo_api",
        "github/pulls/acme/api/8--10.md",
        "MODIFIED",
        "src/a.ts",
      ],
      targetHash: "abc123",
    })
    expect(id).toBe(
      "githubPull:repo_ctx:repo_api:github/pulls/acme/api/8--10.md:MODIFIED:src/a.ts:abc123",
    )
    expect(deriveLogicalSourceKey(id, "abc123")).toBe(
      "githubPull:repo_ctx:repo_api:github/pulls/acme/api/8--10.md:MODIFIED:src/a.ts",
    )
    expect(isConventionalEvidenceSourceId(id, "repo_ctx", "abc123")).toBe(true)
    expect(isConventionalEvidenceSourceId(id, "repo_api", "abc123")).toBe(true)
  })

  it("rejects ids whose hash is mid-string or whose repository id is missing", () => {
    expect(
      isConventionalEvidenceSourceId(
        "githubPull:github/pulls/a/b/1--1.md:abc123:about",
        "repo_ctx",
        "abc123",
      ),
    ).toBe(false)
    expect(
      isConventionalEvidenceSourceId(
        "linkLocatedPaths:repo_api:abc123:file:x:aboutRepo",
        "repo_api",
        "abc123",
      ),
    ).toBe(false)
  })

  it("refuses empty segments and colons in fixed parts", () => {
    expect(() =>
      buildEvidenceSourceId({
        extractor: "x",
        repositoryId: "repo_1",
        segments: [""],
        targetHash: "h",
      }),
    ).toThrow()
    expect(() =>
      buildEvidenceSourceId({
        extractor: "x",
        repositoryId: "repo:1",
        segments: ["a"],
        targetHash: "h",
      }),
    ).toThrow()
  })
})
