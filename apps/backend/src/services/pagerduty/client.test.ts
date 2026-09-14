import { describe, expect, it } from "vitest"
import {
  pagerdutyApiBaseUrl,
  pagerdutyRegionFromHtmlUrl,
  pagerdutySubdomainFromHtmlUrl,
} from "./client.js"

describe("PagerDuty identity helpers", () => {
  it("detects EU accounts from html_url", () => {
    expect(
      pagerdutyRegionFromHtmlUrl("https://acme.eu.pagerduty.com/users/PUSER"),
    ).toBe("eu")
    expect(
      pagerdutyRegionFromHtmlUrl("https://acme.pagerduty.com/users/PUSER"),
    ).toBe("us")
  })

  it("reads the subdomain from html_url", () => {
    expect(
      pagerdutySubdomainFromHtmlUrl("https://acme.pagerduty.com/users/PUSER"),
    ).toBe("acme")
    expect(
      pagerdutySubdomainFromHtmlUrl(
        "https://acme.eu.pagerduty.com/users/PUSER",
      ),
    ).toBe("acme")
  })

  it("selects the regional API host", () => {
    expect(pagerdutyApiBaseUrl("us")).toBe("https://api.pagerduty.com")
    expect(pagerdutyApiBaseUrl("eu")).toBe("https://api.eu.pagerduty.com")
  })
})
