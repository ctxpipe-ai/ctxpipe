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
})
