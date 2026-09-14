import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getPagerdutyAccountIdentity,
  PAGERDUTY_OAUTH_SCOPES,
  pagerdutyApiBaseUrl,
  pagerdutyRegionFromHtmlUrl,
  pagerdutySubdomainFromHtmlUrl,
} from "./client.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

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

  it("requests users.read so /users/me is an allowed Scoped call", () => {
    expect(PAGERDUTY_OAUTH_SCOPES).toContain("users.read")
  })
})

describe("PagerDuty account identity", () => {
  it("uses /users/me when the token is user-scoped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          user: {
            id: "PUSER",
            html_url: "https://acme.pagerduty.com/users/PUSER",
          },
        }),
      ),
    )
    await expect(
      getPagerdutyAccountIdentity({ accessToken: "tok" }),
    ).resolves.toEqual({
      accountId: "acme",
      accountName: "acme",
      accountSubdomain: "acme",
      region: "us",
      actorUserId: "PUSER",
    })
  })

  it("falls back to a service permalink when /users/me is unauthorized", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }))
        .mockResolvedValueOnce(jsonResponse(401, { error: "Unauthorized" }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            services: [
              {
                id: "PSVC",
                name: "API",
                html_url: "https://acme.pagerduty.com/services/PSVC",
              },
            ],
            more: false,
          }),
        ),
    )
    await expect(
      getPagerdutyAccountIdentity({ accessToken: "tok" }),
    ).resolves.toEqual({
      accountId: "acme",
      accountName: "API",
      accountSubdomain: "acme",
      region: "us",
      actorUserId: null,
    })
  })
})
