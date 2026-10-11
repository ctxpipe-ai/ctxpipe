import { describe, expect, it } from "vitest"
import { diffSlice } from "./slice-diff.js"

describe("diffSlice", () => {
  it("writes every slice file and deletes stale owned paths outside the kept ones", () => {
    expect(
      diffSlice(
        {
          ownedPrefixes: ["confluence/"],
          keepPrefixes: ["confluence/HR/"],
          files: [{ path: "confluence/ENG/home.md", content: "# ENG\n" }],
        },
        [
          "confluence/ENG/home.md",
          "confluence/ENG/old.md",
          "confluence/HR/policy.md",
          "notes/user.md",
        ],
      ),
    ).toEqual({
      files: [{ path: "confluence/ENG/home.md", content: "# ENG\n" }],
      deletePaths: ["confluence/ENG/old.md"],
    })
  })

  it("deletes only the patch paths that exist, and keeps the other owned files", () => {
    expect(
      diffSlice(
        {
          ownedPrefixes: ["linear/teams/ENG/"],
          keepPrefixes: [],
          deletePaths: [
            "linear/teams/ENG/issues/a.md",
            "linear/teams/ENG/issues/gone.md",
          ],
          files: [{ path: "linear/teams/ENG/issues/b.md", content: "b" }],
        },
        ["linear/teams/ENG/issues/a.md", "linear/teams/ENG/issues/c.md"],
      ),
    ).toEqual({
      files: [{ path: "linear/teams/ENG/issues/b.md", content: "b" }],
      deletePaths: ["linear/teams/ENG/issues/a.md"],
    })
  })
})
