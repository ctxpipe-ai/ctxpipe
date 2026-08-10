import { describe, expect, it } from "vitest"
import { stableRootStepId } from "./runExtractRoot.js"

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
