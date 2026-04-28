import { describe, expect, it } from "vitest"
import { githubPushTouchesPath } from "./github-push-config-sync.js"

describe("githubPushTouchesPath", () => {
  it("returns true when modified includes path", () => {
    expect(
      githubPushTouchesPath({
        commits: [{ modified: ["foo/bar", "confluence/config.yaml"] }],
        path: "confluence/config.yaml",
      }),
    ).toBe(true)
  })

  it("returns false when commits omit path", () => {
    expect(
      githubPushTouchesPath({
        commits: [{ added: ["README.md"] }],
        path: "confluence/config.yaml",
      }),
    ).toBe(false)
  })
})
