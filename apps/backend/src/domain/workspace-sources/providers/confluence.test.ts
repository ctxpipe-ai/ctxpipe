import { describe, expect, it } from "vitest"
import { parseSourceEntry, summarizeSourceScope } from "../sources-file.js"
import { confluenceSourceScope } from "./confluence.js"

const entry = (scope: Record<string, unknown>) =>
  parseSourceEntry({
    id: "eng-docs",
    provider: "confluence",
    connection: "con_abc123",
    ...scope,
  })

describe("Confluence source scope", () => {
  it("accepts spaces with all pages or a list of page ids", () => {
    const parsed = entry({
      spaces: [
        { key: "ENG", pages: "all" },
        { key: "~5f1a2b", pages: ["101", "202"] },
      ],
    })
    expect(parsed.ok).toBe(true)
  })

  it.each([
    ["no spaces", { spaces: [] }],
    ["a missing pages value", { spaces: [{ key: "ENG" }] }],
    ["an empty page list", { spaces: [{ key: "ENG", pages: [] }] }],
    [
      "a page id that is not a number",
      { spaces: [{ key: "ENG", pages: ["x"] }] },
    ],
    ["a space key with a slash", { spaces: [{ key: "EN/G", pages: "all" }] }],
    [
      "a space two times",
      {
        spaces: [
          { key: "ENG", pages: "all" },
          { key: "ENG", pages: ["1"] },
        ],
      },
    ],
    ["an unknown key", { spaces: [{ key: "ENG", pages: "all" }], teams: [] }],
  ])("rejects %s", (_name, scope) => {
    expect(entry(scope).ok).toBe(false)
  })

  it("summarizes spaces and selected pages", () => {
    expect(
      summarizeSourceScope("confluence", {
        spaces: [{ key: "ENG", pages: "all" }],
      }),
    ).toBe("1 Confluence space")
    expect(
      confluenceSourceScope.summarize({
        spaces: [
          { key: "ENG", pages: "all" },
          { key: "OPS", pages: ["1", "2"] },
        ],
      }),
    ).toBe("2 Confluence spaces · 2 selected pages")
    expect(
      confluenceSourceScope.summarize({
        spaces: [{ key: "OPS", pages: ["1"] }],
      }),
    ).toBe("1 Confluence space · 1 selected page")
  })
})
