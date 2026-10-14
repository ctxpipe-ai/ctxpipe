import { describe, expect, it } from "vitest"
import { parseSourceEntry, summarizeSourceScope } from "../sources-file.js"
import { zendeskSourceScope } from "./zendesk.js"

const entry = (scope: Record<string, unknown>) =>
  parseSourceEntry({
    id: "support",
    provider: "zendesk",
    connection: "con_abc123",
    ...scope,
  })

describe("Zendesk source scope", () => {
  it("accepts Help Center categories, ticket views, or both", () => {
    expect(entry({ categories: ["360001"] }).ok).toBe(true)
    expect(entry({ views: ["900001"] }).ok).toBe(true)
    expect(entry({ categories: ["360001"], views: ["900001"] }).ok).toBe(true)
  })

  it.each([
    ["no categories and no views", {}],
    ["two empty lists", { categories: [], views: [] }],
    ["a category two times", { categories: ["360001", "360001"] }],
    ["a view two times", { views: ["900001", "900001"] }],
    ["a path in an id", { categories: ["../360001"] }],
    ["a name in place of an id", { views: ["Escalations"] }],
    ["a number in place of a string", { views: [900001] }],
    ["an unknown key", { categories: ["360001"], brands: ["1"] }],
  ])("rejects %s", (_name, scope) => {
    expect(entry(scope).ok).toBe(false)
  })

  it("summarizes the categories and views", () => {
    expect(summarizeSourceScope("zendesk", { categories: ["360001"] })).toBe(
      "1 Help Center category",
    )
    expect(
      zendeskSourceScope.summarize({
        categories: ["360001", "360002"],
        views: ["900001"],
      }),
    ).toBe("2 Help Center categories, 1 ticket view")
  })
})
