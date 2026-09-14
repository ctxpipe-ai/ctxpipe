import { describe, expect, it } from "vitest"
import { pagerdutyManagedPathsForIncidentId } from "./converter.js"
import { pagerdutyIncidentIsInScope } from "./incremental.js"

describe("PagerDuty incremental scope", () => {
  const config = {
    accountId: "acme",
    accountName: "acme",
    accountSubdomain: "acme",
    region: "us" as const,
    services: [{ id: "PSVC", name: "checkout" }],
  }

  it("keeps incidents on selected services", () => {
    expect(pagerdutyIncidentIsInScope({ serviceId: "PSVC" }, config)).toBe(true)
    expect(pagerdutyIncidentIsInScope({ serviceId: "POUT" }, config)).toBe(false)
  })

  it("collects an incident file and its assets", () => {
    expect(
      pagerdutyManagedPathsForIncidentId(
        [
          "pagerduty/config.yaml",
          "pagerduty/incidents/12--PT4KHLK.md",
          "pagerduty/incidents/12--PT4KHLK/assets/a.png",
          "pagerduty/incidents/13--OTHER.md",
        ],
        "PT4KHLK",
      ),
    ).toEqual([
      "pagerduty/incidents/12--PT4KHLK.md",
      "pagerduty/incidents/12--PT4KHLK/assets/a.png",
    ])
  })
})
