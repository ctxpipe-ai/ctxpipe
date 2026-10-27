import { describe, expect, it } from "vitest"

import { parseSourceEntry, summarizeSourceScope } from "../sources-file.js"
import { pagerdutySourceScope } from "./pagerduty.js"

const entry = (scope: Record<string, unknown>) =>
  parseSourceEntry({
    id: "on-call",
    provider: "pagerduty",
    connection: "con_abc123",
    ...scope,
  })

describe("PagerDuty source scope", () => {
  it("accepts a list of service ids", () => {
    expect(entry({ services: ["PSVC001"] }).ok).toBe(true)
    expect(entry({ services: ["PSVC001", "P2B3C4D"] }).ok).toBe(true)
  })

  it.each([
    ["no services", {}],
    ["an empty list", { services: [] }],
    ["a service two times", { services: ["PSVC001", "PSVC001"] }],
    ["a path in an id", { services: ["../PSVC001"] }],
    ["a lower-case id", { services: ["psvc001"] }],
    ["an object in place of an id", { services: [{ id: "PSVC001" }] }],
    ["an unknown key", { services: ["PSVC001"], teams: [] }],
  ])("rejects %s", (_name, scope) => {
    expect(entry(scope).ok).toBe(false)
  })

  it("summarizes the service count", () => {
    expect(summarizeSourceScope("pagerduty", { services: ["PSVC001"] })).toBe(
      "1 PagerDuty service",
    )
    expect(
      pagerdutySourceScope.summarize({ services: ["PSVC001", "P2B3C4D"] }),
    ).toBe("2 PagerDuty services")
  })
})
