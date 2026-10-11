import { describe, expect, it } from "vitest"
import {
  conversationDiffFiles,
  formatLineCount,
  groupChangedFilesByFolder,
} from "./conversationDiff"

describe("conversationDiffFiles", () => {
  it("gives each file a status and its added and removed line counts", () => {
    const files = conversationDiffFiles([
      { path: "new.md", oldBody: null, body: "a\nb\n" },
      { path: "gone.md", oldBody: "x\ny\nz\n", body: null },
      { path: "edit.md", oldBody: "one\ntwo\n", body: "one\n2\nthree\n" },
    ])
    expect(
      files.map(({ path, status, additions, deletions }) => ({
        path,
        status,
        additions,
        deletions,
      })),
    ).toEqual([
      { path: "new.md", status: "added", additions: 2, deletions: 0 },
      { path: "gone.md", status: "deleted", additions: 0, deletions: 3 },
      { path: "edit.md", status: "modified", additions: 2, deletions: 1 },
    ])
  })
})

describe("groupChangedFilesByFolder", () => {
  it("groups files by folder in path order and adds up each folder", () => {
    const groups = groupChangedFilesByFolder([
      {
        path: "apps/ui/src/b.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
      },
      { path: "README.md", status: "modified", additions: 1, deletions: 0 },
      { path: "apps/ui/src/a.ts", status: "added", additions: 4, deletions: 0 },
      {
        path: "scripts/ci/x.sh",
        status: "deleted",
        additions: 0,
        deletions: 9,
      },
    ])
    expect(
      groups.map((group) => ({
        folder: group.folder,
        additions: group.additions,
        deletions: group.deletions,
        files: group.files.map((file) => file.path),
      })),
    ).toEqual([
      { folder: "", additions: 1, deletions: 0, files: ["README.md"] },
      {
        folder: "apps/ui/src",
        additions: 7,
        deletions: 1,
        files: ["apps/ui/src/a.ts", "apps/ui/src/b.ts"],
      },
      {
        folder: "scripts/ci",
        additions: 0,
        deletions: 9,
        files: ["scripts/ci/x.sh"],
      },
    ])
  })
})

describe("formatLineCount", () => {
  it("shortens large counts", () => {
    expect(formatLineCount(12)).toBe("12")
    expect(formatLineCount(1_234)).toBe("1.2k")
    expect(formatLineCount(297_000)).toBe("297k")
  })
})
