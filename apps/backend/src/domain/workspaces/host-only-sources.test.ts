import { describe, expect, it } from "vitest"
import { isHostOnlyPath } from "./host-only.js"

// CTX-721: a source file grants data flow, so only a write through a pull
// request can change `sources/`.
describe("isHostOnlyPath for sources/", () => {
  it.each([
    "sources",
    "sources/github/example-org/checkout-api.md",
    "sources/linear/eng.md",
    "Sources/github/evil/exfil.md",
    "SOURCES/notion/wiki.md",
  ])("finds the host-only path %s", (path) => {
    expect(isHostOnlyPath(path)).toBe(true)
  })

  it.each([
    "knowledge/sources/notes.md",
    "sources-notes.md",
    "sourcesx/github/a.md",
    "knowledge/services/checkout.md",
  ])("lets the agent write %s", (path) => {
    expect(isHostOnlyPath(path)).toBe(false)
  })
})
