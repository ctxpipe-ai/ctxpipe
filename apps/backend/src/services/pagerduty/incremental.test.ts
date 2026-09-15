import { beforeEach, describe, expect, it, vi } from "vitest"
import { createConnectorAssetBudget } from "../connectors/assets.js"
import { pagerdutyManagedPathsForIncidentId } from "./converter.js"
import {
  buildPagerdutyIncrementalChanges,
  pagerdutyIncidentIsInScope,
} from "./incremental.js"

const mocks = vi.hoisted(() => ({
  getIncident: vi.fn(),
  downloadAsset: vi.fn(),
}))

vi.mock("./client.js", () => ({
  getPagerdutyIncident: mocks.getIncident,
}))
vi.mock("../connectors/assets.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../connectors/assets.js")>()
  return {
    ...actual,
    downloadConnectorAsset: mocks.downloadAsset,
  }
})

describe("PagerDuty incremental scope", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

  it("preserves the prior binary when an incremental image download fails", async () => {
    mocks.getIncident.mockResolvedValue({
      id: "PT4KHLK",
      number: 12,
      title: "High CPU",
      htmlUrl: "https://acme.pagerduty.com/incidents/PT4KHLK",
      status: "triggered",
      serviceId: "PSVC",
      alerts: [
        {
          id: "PALERT1",
          summary: "High CPU",
          contexts: [
            {
              type: "image",
              text: "graph",
              src: "https://cdn.example.com/graph.png",
            },
          ],
        },
      ],
      notes: [],
    })
    mocks.downloadAsset.mockResolvedValue({
      status: "stub",
      reason: "download_failed",
    })
    const preserved = "pagerduty/incidents/12--PT4KHLK/assets/PALERT1-image-0.png"

    const result = await buildPagerdutyIncrementalChanges({
      env: {} as never,
      connection: {
        accessToken: "token",
        region: "us",
      } as never,
      config,
      entity: { incidentId: "PT4KHLK", action: "upsert" },
      existingPaths: [
        "pagerduty/incidents/12--PT4KHLK.md",
        preserved,
        "pagerduty/incidents/12--PT4KHLK/assets/stale.png",
      ],
      budget: createConnectorAssetBudget(),
    })

    const markdown = result.files.find((file) =>
      file.path.endsWith("12--PT4KHLK.md"),
    )
    expect(markdown?.content).toContain(
      "[image: graph — view in PagerDuty](https://acme.pagerduty.com/incidents/PT4KHLK)",
    )
    expect(markdown?.content).not.toContain("cdn.example.com/graph.png")
    expect(result.deletePaths).not.toContain(preserved)
    expect(result.deletePaths).toContain(
      "pagerduty/incidents/12--PT4KHLK/assets/stale.png",
    )
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
