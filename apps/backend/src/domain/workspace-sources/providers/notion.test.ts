import { describe, expect, it } from "vitest"

import { parseSourceEntry, summarizeSourceScope } from "../sources-file.js"
import { canonicalNotionId, notionSourceScope } from "./notion.js"

const PAGE = "1a2b3c4d-0000-4000-8000-000000000001"
const DATABASE = "1a2b3c4d-0000-4000-8000-000000000002"

const entry = (scope: Record<string, unknown>) =>
  parseSourceEntry({
    id: "eng-notes",
    provider: "notion",
    connection: "con_abc123",
    ...scope,
  })

describe("Notion source scope", () => {
  it("accepts root pages, databases, or both", () => {
    expect(entry({ pages: [{ id: PAGE, title: "Handbook" }] }).ok).toBe(true)
    expect(entry({ databases: [{ id: DATABASE, title: "Tasks" }] }).ok).toBe(
      true,
    )
    expect(
      entry({
        pages: [{ id: PAGE, title: "Handbook" }],
        databases: [{ id: DATABASE, title: "Tasks" }],
      }).ok,
    ).toBe(true)
  })

  it.each([
    ["no roots", {}],
    ["empty lists", { pages: [], databases: [] }],
    [
      "an id without dashes",
      { pages: [{ id: PAGE.replaceAll("-", ""), title: "A" }] },
    ],
    ["an upper-case id", { pages: [{ id: PAGE.toUpperCase(), title: "A" }] }],
    ["a missing title", { pages: [{ id: PAGE }] }],
    ["an empty title", { pages: [{ id: PAGE, title: " " }] }],
    [
      "a page two times",
      {
        pages: [
          { id: PAGE, title: "A" },
          { id: PAGE, title: "B" },
        ],
      },
    ],
    ["an unknown key", { pages: [{ id: PAGE, title: "A" }], spaces: [] }],
  ])("rejects %s", (_name, scope) => {
    expect(entry(scope).ok).toBe(false)
  })

  it("summarizes pages and databases", () => {
    expect(
      summarizeSourceScope("notion", {
        pages: [{ id: PAGE, title: "Handbook" }],
      }),
    ).toBe("1 Notion page")
    expect(
      notionSourceScope.summarize({
        pages: [
          { id: PAGE, title: "Handbook" },
          { id: DATABASE, title: "Other" },
        ],
        databases: [{ id: DATABASE, title: "Tasks" }],
      }),
    ).toBe("2 Notion pages · 1 Notion database")
  })

  it("puts an id from a URL into the scope form", () => {
    expect(canonicalNotionId(PAGE.replaceAll("-", "").toUpperCase())).toBe(PAGE)
    expect(canonicalNotionId("not-an-id")).toBeNull()
  })
})
