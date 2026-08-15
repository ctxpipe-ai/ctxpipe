import { describe, expect, it } from "vitest"
import { parsePane, serializePane } from "./pane"

describe("parsePane", () => {
  it("maps built-in ids", () => {
    expect(parsePane("files")).toEqual({ kind: "files" })
    expect(parsePane("graph")).toEqual({ kind: "graph" })
    expect(parsePane("settings")).toEqual({ kind: "settings" })
  })

  it("decodes file paths", () => {
    expect(parsePane("file:knowledge%2Freadme.md")).toEqual({
      kind: "file",
      path: "knowledge/readme.md",
    })
  })

  it("keeps unknown ids", () => {
    expect(parsePane("jobs")).toEqual({ kind: "unknown", id: "jobs" })
  })

  it("returns null when missing", () => {
    expect(parsePane(undefined)).toBeNull()
    expect(parsePane("")).toBeNull()
  })
})

describe("serializePane", () => {
  it("round-trips file paths", () => {
    const pane = parsePane(serializePane({ kind: "file", path: "a/b.md" }))
    expect(pane).toEqual({ kind: "file", path: "a/b.md" })
  })
})
