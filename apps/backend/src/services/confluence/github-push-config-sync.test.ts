import { describe, expect, it } from "vitest"
import {
  githubCommitsMissingPathEntirely,
  githubPushTouchesPath,
} from "./github-push-config-sync.js"

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

describe("githubCommitsMissingPathEntirely", () => {
  it("returns true when commits omit path everywhere", () => {
    expect(
      githubCommitsMissingPathEntirely({
        commits: [{ modified: ["README.md"] }],
        path: "confluence/config.yaml",
      }),
    ).toBe(true)
  })

  it("returns false when path appears in a commit list", () => {
    expect(
      githubCommitsMissingPathEntirely({
        commits: [
          { modified: ["README.md"] },
          { added: ["confluence/config.yaml"] },
        ],
        path: "confluence/config.yaml",
      }),
    ).toBe(false)
  })
})
