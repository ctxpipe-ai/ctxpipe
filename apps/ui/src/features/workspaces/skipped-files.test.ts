import { describe, expect, it } from "vitest"
import { skippedFilesInTree } from "./skipped-files"

const files = [
  { path: "knowledge/apis/imported.md", reason: "malformed" as const },
  { path: "knowledge/billing/tax.md", reason: "malformed" as const },
  { path: "repositories/app.md", reason: "duplicate_repository" as const },
]

describe("skippedFilesInTree", () => {
  it("keeps only files of the tree, and offers the agent for front matter only", () => {
    const result = skippedFilesInTree(files, [
      "knowledge/billing/tax.md",
      "repositories/app.md",
    ])
    expect(result.files.map((file) => file.path)).toEqual([
      "knowledge/billing/tax.md",
      "repositories/app.md",
    ])
    expect([...result.fixable]).toEqual(["knowledge/billing/tax.md"])
    expect(result.checked).toBe(true)
  })

  it("lists every file with no fix when the tree is unknown", () => {
    for (const tree of [undefined, []]) {
      const result = skippedFilesInTree(files, tree)
      expect(result.files).toEqual(files)
      expect(result.fixable.size).toBe(0)
      expect(result.checked).toBe(false)
    }
  })
})
