import { describe, expect, it } from "vitest"
import {
  narrowRootsForPartialDiff,
  normalizeMonorepoRootPrefix,
  pathStartsWithRootPrefix,
  stripLeadingDotSlash,
} from "./narrowRootsForPartialDiff.js"

describe("narrowRootsForPartialDiff", () => {
  it("returns roots unchanged when diff paths are empty", () => {
    const roots = ["apps/backend", "apps/ui"]
    expect(narrowRootsForPartialDiff(roots, [], [], [])).toEqual(roots)
    expect(
      narrowRootsForPartialDiff(roots, undefined, undefined, undefined),
    ).toEqual(roots)
  })

  it("narrows to roots that prefix-match changed paths", () => {
    expect(
      narrowRootsForPartialDiff(
        ["apps/backend", "apps/ui", "packages/foo"],
        ["apps/backend/src/a.ts"],
        [],
        [],
      ),
    ).toEqual(["apps/backend"])
  })

  it("matches deleted paths and rename from/to", () => {
    expect(
      narrowRootsForPartialDiff(
        ["apps/backend", "apps/ui"],
        [],
        ["./apps/ui/old.txt"],
        [{ from: "apps/backend/a.ts", to: "apps/backend/b.ts" }],
      ),
    ).toEqual(["apps/backend", "apps/ui"])
  })

  it("normalizes ./ vs repo-relative paths", () => {
    expect(
      narrowRootsForPartialDiff(
        ["./apps/backend", "apps/ui"],
        ["apps/backend/x.ts"],
        [],
        [],
      ),
    ).toEqual(["./apps/backend"])
  })

  it("returns empty when nothing matches (caller may fall back to full roots)", () => {
    expect(
      narrowRootsForPartialDiff(
        ["apps/backend", "apps/ui"],
        ["packages/zed.ts"],
        [],
        [],
      ),
    ).toEqual([])
  })
})

describe("path helpers", () => {
  it("stripLeadingDotSlash removes a single leading ./", () => {
    expect(stripLeadingDotSlash("./apps/x")).toBe("apps/x")
    expect(stripLeadingDotSlash("apps/x")).toBe("apps/x")
  })

  it("normalizeMonorepoRootPrefix maps ./ to repo root", () => {
    expect(normalizeMonorepoRootPrefix("./")).toBe("")
    expect(normalizeMonorepoRootPrefix(".")).toBe("")
    expect(normalizeMonorepoRootPrefix("")).toBe("")
  })

  it("pathStartsWithRootPrefix treats repo root as matching all paths", () => {
    expect(pathStartsWithRootPrefix("README.md", "")).toBe(true)
    expect(pathStartsWithRootPrefix("./foo", "")).toBe(true)
  })
})
