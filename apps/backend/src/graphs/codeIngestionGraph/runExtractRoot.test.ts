import { describe, expect, it } from "vitest"
import { captureRowRoot, stableRootStepId } from "./runExtractRoot.js"

describe("stableRootStepId", () => {
  it("maps repo root aliases to repo-root", () => {
    expect(stableRootStepId("./")).toBe("repo-root")
    expect(stableRootStepId(".")).toBe("repo-root")
    expect(stableRootStepId("")).toBe("repo-root")
  })

  it("sanitizes nested paths for OW step names", () => {
    expect(stableRootStepId("apps/backend")).toBe("apps_backend")
    expect(stableRootStepId("./packages/foo-bar")).toBe("packages_foo-bar")
  })
})

describe("captureRowRoot", () => {
  it("names the row of the root that reads the repo-root instruction files apart", () => {
    const roots = ["packages/beta", "packages/alpha"]
    expect(captureRowRoot("packages/alpha", roots)).toBe(
      "packages/alpha#repo-root",
    )
    expect(captureRowRoot("packages/beta", roots)).toBe("packages/beta")
    // A different root set gives packages/beta the files, under a new row name.
    expect(captureRowRoot("packages/beta", ["packages/beta"])).toBe(
      "packages/beta#repo-root",
    )
  })

  it("keeps plain row names when the run has a repository root", () => {
    const roots = ["./", "packages/alpha"]
    expect(captureRowRoot("./", roots)).toBe("./")
    expect(captureRowRoot("packages/alpha", roots)).toBe("packages/alpha")
  })
})
