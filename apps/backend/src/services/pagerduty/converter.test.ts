import { describe, expect, it } from "vitest"
import {
  pagerdutyIncidentMarkdownPath,
  renderPagerdutyIncidentMarkdown,
} from "./converter.js"

const baseIncident = {
  id: "PT4KHLK",
  number: 12,
  title: "High CPU on prod-api",
  htmlUrl: "https://acme.pagerduty.com/incidents/PT4KHLK",
  status: "triggered",
  urgency: "high",
  serviceId: "PYYYYYY",
  serviceName: "checkout-api",
  serviceUrl: "https://acme.pagerduty.com/service-directory/PYYYYYY",
  alerts: [] as never[],
  notes: [] as never[],
}

describe("renderPagerdutyIncidentMarkdown", () => {
  it("includes triggering alert body.details hostname", () => {
    const markdown = renderPagerdutyIncidentMarkdown({
      ...baseIncident,
      alerts: [
        {
          id: "PALERT1",
          summary: "High CPU usage on web-server-01",
          severity: "critical",
          status: "triggered",
          details: {
            hostname: "web-server-01",
            cpu_usage: "95%",
            routing_key: "should-not-appear",
          },
        },
      ],
    })
    expect(markdown).toContain("web-server-01")
    expect(markdown).toContain("95%")
    expect(markdown).not.toContain("should-not-appear")
    expect(markdown).not.toContain("routing_key")
    expect(pagerdutyIncidentMarkdownPath(12, "PT4KHLK")).toBe(
      "pagerduty/incidents/12--PT4KHLK.md",
    )
  })

  it("renders notes and overflows extra alerts", () => {
    const markdown = renderPagerdutyIncidentMarkdown({
      ...baseIncident,
      alerts: Array.from({ length: 6 }, (_, index) => ({
        id: `A${index}`,
        summary: `alert-${index}`,
        severity: "error",
        status: "triggered",
        createdAt: `2024-03-15T14:3${index}:00Z`,
        details: index === 0 ? { hostname: "web-server-01" } : undefined,
      })),
      notes: [
        {
          id: "N1",
          content: "Restarted the worker pool",
          userName: "Ada",
          createdAt: "2024-03-15T14:40:00Z",
        },
      ],
    })
    expect(markdown).toContain("Restarted the worker pool")
    expect(markdown).toContain("alert-1")
    expect(markdown).toContain("alert-4")
    expect(markdown).not.toContain("alert-5")
    expect(markdown).toContain("1 further alerts not mirrored")
  })
})
