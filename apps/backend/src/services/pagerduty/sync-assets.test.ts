import { posix } from "node:path"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createConnectorAssetBudget } from "../connectors/assets.js"
import { getPagerdutyIncident } from "./client.js"
import {
  pagerdutyAlertAssetCandidates,
  pagerdutyIncidentAssetLink,
  pagerdutyIncidentMarkdownPath,
} from "./converter.js"
import { capturePagerdutyIncidentAssets } from "./sync-assets.js"

const hostileIncident = "../../PINC"
const hostileAlert = "../../../.ctxpipe/PALERT"
const folder = "pagerduty/services/PSVC001/incidents/"

const server = setupServer(
  http.get("https://api.pagerduty.com/incidents/:incidentId", ({ params }) =>
    HttpResponse.json({
      incident: {
        id: String(params.incidentId),
        incident_number: 31,
        title: "Hostile ids",
        html_url: "https://acme.pagerduty.com/incidents/x",
        status: "triggered",
        service: { id: "PSVC001", summary: "Checkout" },
      },
    }),
  ),
  http.get("https://api.pagerduty.com/incidents/:incidentId/alerts", () =>
    HttpResponse.json({
      alerts: [
        {
          id: hostileAlert,
          summary: "Graph",
          body: {
            details: {},
            // An http source is not downloaded, so the capture stays offline.
            contexts: [
              { type: "image", src: "http://images.example.com/g.png" },
            ],
          },
        },
      ],
    }),
  ),
  http.get("https://api.pagerduty.com/incidents/:incidentId/notes", () =>
    HttpResponse.json({ notes: [] }),
  ),
)

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterAll(() => server.close())

async function hostileIncidentFromProvider() {
  const incident = await getPagerdutyIncident({
    accessToken: "fixture-token",
    region: "us",
    incidentId: hostileIncident,
  })
  if (incident === "not_found") throw new Error("incident not served")
  return incident
}

describe("PagerDuty incident asset names", () => {
  it("names an alert image from the cleaned alert id, inside the incident folder", async () => {
    const incident = await hostileIncidentFromProvider()

    const [candidate, ...others] = pagerdutyAlertAssetCandidates(
      incident,
      folder,
    )

    expect(others).toEqual([])
    expect(candidate?.filename).toBe(
      `${folder}31---.-..-PINC/assets/-.-..-..-.ctxpipe-PALERT-image-0.png`,
    )
    expect(
      candidate?.filename
        .split("/")
        .some((part) => ["", "..", "."].includes(part)),
    ).toBe(false)
  })

  it("keeps the whole capture under the folder when an id is hostile", async () => {
    const incident = await hostileIncidentFromProvider()

    const { files, preservePathPrefixes } =
      await capturePagerdutyIncidentAssets({
        incident,
        budget: createConnectorAssetBudget(),
        root: folder,
      })

    const paths = [...files.map((file) => file.path), ...preservePathPrefixes]
    expect(paths).toHaveLength(2)
    for (const path of paths) {
      expect(path.startsWith(folder)).toBe(true)
      expect(
        path.split("/").some((part) => ["", "..", "."].includes(part)),
      ).toBe(false)
    }
  })

  it("links an asset by the same cleaned id as its path", async () => {
    const incident = await hostileIncidentFromProvider()
    const [candidate] = pagerdutyAlertAssetCandidates(incident, folder)
    if (!candidate) throw new Error("no candidate")

    const link = pagerdutyIncidentAssetLink(
      incident.number,
      incident.id,
      candidate.filename,
    )

    const markdownPath = pagerdutyIncidentMarkdownPath(
      incident.number,
      incident.id,
      folder,
    )
    expect(posix.join(posix.dirname(markdownPath), link)).toBe(
      candidate.filename,
    )
  })
})
