import { describe, expect, it } from "vitest"
import {
  landingPane,
  paneSearchForOtherConversation,
  parsePane,
  serializePane,
  visiblePane,
} from "./pane"

describe("parsePane", () => {
  it("maps built-in ids", () => {
    expect(parsePane("files")).toEqual({ kind: "files" })
    expect(parsePane("graph")).toEqual({ kind: "graph" })
    expect(parsePane("settings")).toEqual({ kind: "settings" })
    expect(parsePane("diff")).toEqual({ kind: "diff" })
  })

  it("decodes file paths", () => {
    expect(parsePane("file:knowledge%2Freadme.md")).toEqual({
      kind: "file",
      path: "knowledge/readme.md",
    })
  })

  it("round-trips a diff pane that focuses a file of one turn", () => {
    const pane = {
      kind: "diff" as const,
      turn: "run_1",
      path: "notes/a b&c.md",
    }
    const raw = serializePane(pane)
    expect(raw.startsWith("diff:")).toBe(true)
    expect(parsePane(raw)).toEqual(pane)
    expect(parsePane(serializePane({ kind: "diff", path: "x.md" }))).toEqual({
      kind: "diff",
      path: "x.md",
    })
    expect(serializePane({ kind: "diff" })).toBe("diff")
    expect(parsePane("diff:")).toEqual({ kind: "diff" })
  })

  it("keeps unknown ids", () => {
    expect(parsePane("jobs")).toEqual({ kind: "unknown", id: "jobs" })
    expect(visiblePane(parsePane("jobs"))).toBeNull()
    expect(visiblePane(parsePane("files"))).toEqual({ kind: "files" })
  })

  it("returns null when missing", () => {
    expect(parsePane(undefined)).toBeNull()
    expect(parsePane("")).toBeNull()
  })
})

describe("landingPane", () => {
  it("is closed when search is empty", () => {
    expect(landingPane(undefined)).toBeNull()
    expect(landingPane("")).toBeNull()
  })

  it("keeps a visible URL pane", () => {
    expect(landingPane("diff")).toEqual({ kind: "diff" })
    expect(landingPane("graph")).toEqual({ kind: "graph" })
    expect(landingPane("file:README.md")).toEqual({
      kind: "file",
      path: "README.md",
    })
  })
})

describe("serializePane", () => {
  it("round-trips file paths", () => {
    const pane = parsePane(serializePane({ kind: "file", path: "a/b.md" }))
    expect(pane).toEqual({ kind: "file", path: "a/b.md" })
  })
})

describe("paneSearchForOtherConversation", () => {
  it("turns a file pane into the Files pane", () => {
    expect(paneSearchForOtherConversation({ pane: "file:a.md" })).toEqual({
      pane: "files",
    })
  })

  it("drops a diff pane", () => {
    expect(paneSearchForOtherConversation({ pane: "diff:turn=t1" })).toEqual({
      pane: undefined,
    })
    expect(paneSearchForOtherConversation({ pane: "diff" })).toEqual({
      pane: undefined,
    })
  })

  it("keeps panes that do not depend on the conversation", () => {
    for (const pane of ["files", "graph", "settings"]) {
      expect(paneSearchForOtherConversation({ pane })).toEqual({ pane })
    }
  })

  it("keeps no pane as no pane", () => {
    expect(paneSearchForOtherConversation({})).toEqual({ pane: undefined })
  })
})
