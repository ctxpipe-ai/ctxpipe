import { describe, expect, it } from "vitest"
import { workspaceTreeEntries } from "./WorkspaceFileTree"

describe("workspaceTreeEntries", () => {
  it("keeps a deleted file in the tree but not as an openable file", () => {
    const entries = workspaceTreeEntries(
      ["AGENTS.md", "knowledge/a.md"],
      [{ path: "knowledge/gone.md", status: "deleted" }],
    )
    expect(entries.paths).toEqual([
      "AGENTS.md",
      "knowledge/a.md",
      "knowledge/gone.md",
    ])
    expect(entries.deleted).toEqual(["knowledge/gone.md"])
    expect(entries.files.has("knowledge/gone.md")).toBe(false)
    expect(entries.files.has("knowledge/a.md")).toBe(true)
  })

  it("keeps a folder whose files were all deleted", () => {
    const entries = workspaceTreeEntries(
      ["AGENTS.md"],
      [
        { path: "old/a.md", status: "deleted" },
        { path: "old/b.md", status: "deleted" },
      ],
    )
    expect(entries.paths).toEqual(["AGENTS.md", "old/a.md", "old/b.md"])
    expect(entries.files).toEqual(new Set(["AGENTS.md"]))
  })

  it("does not list a path twice when the worktree still lists it", () => {
    const entries = workspaceTreeEntries(
      ["AGENTS.md", "gone.md"],
      [{ path: "gone.md", status: "deleted" }],
    )
    expect(entries.paths).toEqual(["AGENTS.md", "gone.md"])
    expect(entries.files.has("gone.md")).toBe(false)
  })

  it("drops the deleted path after the status clears", () => {
    const entries = workspaceTreeEntries(["AGENTS.md"], [])
    expect(entries.paths).toEqual(["AGENTS.md"])
    expect(entries.deleted).toEqual([])
  })

  it("ignores added and modified paths", () => {
    const entries = workspaceTreeEntries(
      ["AGENTS.md", "new.md"],
      [
        { path: "new.md", status: "added" },
        { path: "AGENTS.md", status: "modified" },
      ],
    )
    expect(entries.paths).toEqual(["AGENTS.md", "new.md"])
    expect(entries.files).toEqual(new Set(["AGENTS.md", "new.md"]))
  })
})
