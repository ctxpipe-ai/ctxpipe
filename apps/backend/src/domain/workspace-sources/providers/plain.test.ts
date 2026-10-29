import { describe, expect, it } from "vitest"

import { parseSourceEntry, summarizeSourceScope } from "../sources-file.js"
import { plainSourceScope } from "./plain.js"

const entry = (scope: Record<string, unknown>) =>
  parseSourceEntry({
    id: "support",
    provider: "plain",
    connection: "con_abc123",
    ...scope,
  })

describe("Plain source scope", () => {
  it("accepts Help Centers, thread labels, or both", () => {
    expect(entry({ helpCenters: ["hc_01HXYZ"] }).ok).toBe(true)
    expect(entry({ labels: ["lt_01HXYZ"] }).ok).toBe(true)
    expect(
      entry({ helpCenters: ["hc_01HXYZ"], labels: ["lt_01HXYZ"] }).ok,
    ).toBe(true)
  })

  it.each([
    ["no Help Centers and no labels", {}],
    ["two empty lists", { helpCenters: [], labels: [] }],
    ["a Help Center two times", { helpCenters: ["hc_1", "hc_1"] }],
    ["a label two times", { labels: ["lt_1", "lt_1"] }],
    ["a path in an id", { helpCenters: ["../hc_1"] }],
    ["a name in place of an id", { labels: ["Bug report"] }],
    ["a number in place of a string", { labels: [1] }],
    ["an unknown key", { labels: ["lt_1"], tiers: ["t_1"] }],
  ])("rejects %s", (_name, scope) => {
    expect(entry(scope).ok).toBe(false)
  })

  it("summarizes the Help Centers and labels", () => {
    expect(summarizeSourceScope("plain", { helpCenters: ["hc_1"] })).toBe(
      "1 Help Center",
    )
    expect(
      plainSourceScope.summarize({
        helpCenters: ["hc_1", "hc_2"],
        labels: ["lt_1"],
      }),
    ).toBe("2 Help Centers, 1 thread label")
  })
})
