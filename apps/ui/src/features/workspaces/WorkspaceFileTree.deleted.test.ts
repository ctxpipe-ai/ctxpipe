import { describe, expect, it } from "vitest"
import { workspaceTreeEntries } from "./WorkspaceFileTree"

describe("workspaceTreeEntries", () => {
  it("keeps a deleted file in the tree but not as an openable file", () => {
    const entries = workspaceTreeEntries(
      ["AGENTS.md", "knowledge/a.md"],
      ["knowledge/gone.md"],
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
      ["old/a.md", "old/b.md"],
    )
    expect(entries.paths).toEqual(["AGENTS.md", "old/a.md", "old/b.md"])
    expect(entries.files).toEqual(new Set(["AGENTS.md"]))
  })

  it("does not list a path twice when the worktree still lists it", () => {
    const entries = workspaceTreeEntries(["AGENTS.md", "gone.md"], ["gone.md"])
    expect(entries.paths).toEqual(["AGENTS.md", "gone.md"])
    expect(entries.files.has("gone.md")).toBe(false)
  })

  it("drops the deleted path after the status clears", () => {
    const entries = workspaceTreeEntries(["AGENTS.md"], [])
    expect(entries.paths).toEqual(["AGENTS.md"])
    expect(entries.deleted).toEqual([])
  })
})

describe("isDeletedRow", () => {
  const entries = workspaceTreeEntries(
    ["AGENTS.md", "knowledge/billing.md"],
    ["knowledge/archive/2023.md", "knowledge/archive/old/2022.md", "gone.md"],
  )

  it("marks a deleted file", () => {
    expect(entries.isDeletedRow("gone.md")).toBe(true)
    expect(entries.isDeletedRow("AGENTS.md")).toBe(false)
  })

  it("marks a folder when every row under it is deleted", () => {
    expect(entries.isDeletedRow("knowledge/archive")).toBe(true)
    expect(entries.isDeletedRow("knowledge/archive/")).toBe(true)
    expect(entries.isDeletedRow("knowledge/archive/old")).toBe(true)
  })

  it("does not mark a folder that still has a file", () => {
    expect(entries.isDeletedRow("knowledge")).toBe(false)
    expect(entries.isDeletedRow("knowledge/")).toBe(false)
  })

  it("does not mark an unknown path", () => {
    expect(entries.isDeletedRow("missing")).toBe(false)
  })
})
