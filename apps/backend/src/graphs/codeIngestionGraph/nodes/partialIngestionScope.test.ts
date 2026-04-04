import { describe, expect, it } from "vitest"
import type { CodeIngestionState } from "../schemas.js"
import {
  filterPathsByPartialScan,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

function state(partial: Partial<CodeIngestionState>): CodeIngestionState {
  return {
    repositoryId: "r1",
    orgId: "o1",
    targetHash: "h1",
    ...partial,
  } as CodeIngestionState
}

describe("repoPathMatchesPartialScan", () => {
  it("treats empty scanPaths as full-repo (all paths match)", () => {
    expect(repoPathMatchesPartialScan("apps/web/foo.ts", [])).toBe(true)
    expect(repoPathMatchesPartialScan("./pkg/x", [])).toBe(true)
  })

  it("matches exact path and child paths under a scan prefix", () => {
    const scan = ["apps/web"]
    expect(repoPathMatchesPartialScan("apps/web", scan)).toBe(true)
    expect(repoPathMatchesPartialScan("apps/web/src/index.ts", scan)).toBe(true)
    expect(repoPathMatchesPartialScan("./apps/web/src", scan)).toBe(true)
  })

  it("matches when repo path is a prefix of a scan anchor (parent scope)", () => {
    const scan = ["apps/web/src/lib"]
    expect(repoPathMatchesPartialScan("apps/web", scan)).toBe(true)
    expect(repoPathMatchesPartialScan("apps/web/src", scan)).toBe(true)
  })

  it("does not match unrelated siblings", () => {
    const scan = ["apps/web"]
    expect(repoPathMatchesPartialScan("apps/api/main.ts", scan)).toBe(false)
    expect(repoPathMatchesPartialScan("other/apps/web", scan)).toBe(false)
  })

  it("treats empty scan anchor as full-repo", () => {
    expect(repoPathMatchesPartialScan("any/path", [""])).toBe(true)
    expect(repoPathMatchesPartialScan("x", ["  "])).toBe(true)
  })
})

describe("filterPathsByPartialScan", () => {
  it("returns the input list when scanPaths is empty", () => {
    const paths = ["a/b", "c/d"]
    expect(filterPathsByPartialScan(paths, [])).toEqual(paths)
  })

  it("filters to paths matching any scan prefix", () => {
    expect(
      filterPathsByPartialScan(
        ["apps/web/a", "apps/api/b", "apps/web/pkg/x"],
        ["apps/web"],
      ),
    ).toEqual(["apps/web/a", "apps/web/pkg/x"])
  })
})

describe("shouldSkipExtractorForPartialDeletesOnly", () => {
  it("returns true for partial ingest with only deletes (no changes or renames)", () => {
    expect(
      shouldSkipExtractorForPartialDeletesOnly(
        state({
          ingestMode: "partial",
          changedPaths: [],
          deletedPaths: ["gone.ts"],
          renames: [],
        }),
      ),
    ).toBe(true)
  })

  it("returns false when there are changed paths", () => {
    expect(
      shouldSkipExtractorForPartialDeletesOnly(
        state({
          ingestMode: "partial",
          changedPaths: ["a.ts"],
          deletedPaths: ["gone.ts"],
          renames: [],
        }),
      ),
    ).toBe(false)
  })

  it("returns false when there are renames", () => {
    expect(
      shouldSkipExtractorForPartialDeletesOnly(
        state({
          ingestMode: "partial",
          changedPaths: [],
          deletedPaths: ["gone.ts"],
          renames: [{ from: "a", to: "b" }],
        }),
      ),
    ).toBe(false)
  })

  it("returns false for full ingest", () => {
    expect(
      shouldSkipExtractorForPartialDeletesOnly(
        state({
          ingestMode: "full",
          changedPaths: [],
          deletedPaths: ["gone.ts"],
          renames: [],
        }),
      ),
    ).toBe(false)
  })
})
