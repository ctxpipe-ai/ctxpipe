import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ensurePagerdutyWebhookSubscription,
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

const SHARED_DELIVERY_URL = "https://app.ctxpipe.ai/api/v1/webhook/pagerduty"

function webhookSubscriptionFetch(options: {
  listed: Array<{ id: string; url: string }>
  createdId?: string
}): { deletedIds: string[]; fetchMock: ReturnType<typeof vi.fn> } {
  const deletedIds: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    if (method === "GET" && href.endsWith("/webhook_subscriptions")) {
      return jsonResponse(200, {
        webhook_subscriptions: options.listed.map((subscription) => ({
          id: subscription.id,
          delivery_method: { url: subscription.url },
        })),
      })
    }
    if (method === "POST" && href.endsWith("/webhook_subscriptions")) {
      return jsonResponse(200, {
        webhook_subscription: {
          id: options.createdId ?? "PFNEW",
          delivery_method: { secret: "new-secret" },
        },
      })
    }
    const deleteMatch = href.match(/\/webhook_subscriptions\/([^/?]+)$/)
    if (method === "DELETE" && deleteMatch) {
      deletedIds.push(decodeURIComponent(deleteMatch[1] ?? ""))
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected ${method} ${href}`)
  })
  return { deletedIds, fetchMock }
}

describe("ensurePagerdutyWebhookSubscription", () => {
  it("does not delete another organization's subscription on the shared Event URL", async () => {
    const { deletedIds, fetchMock } = webhookSubscriptionFetch({
      listed: [{ id: "PFORG1", url: SHARED_DELIVERY_URL }],
      createdId: "PFORG2",
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      ensurePagerdutyWebhookSubscription({
        accessToken: "tok",
        region: "us",
        deliveryUrl: SHARED_DELIVERY_URL,
        existingSubscriptionId: null,
        hasStoredSecret: false,
      }),
    ).resolves.toEqual({ id: "PFORG2", secret: "new-secret" })
    expect(deletedIds).not.toContain("PFORG1")
  })

  it("replaces only this connection's subscription when the signing secret is missing", async () => {
    const { deletedIds, fetchMock } = webhookSubscriptionFetch({
      listed: [
        { id: "PFTHIS", url: SHARED_DELIVERY_URL },
        { id: "PFORG1", url: SHARED_DELIVERY_URL },
      ],
      createdId: "PFNEW",
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      ensurePagerdutyWebhookSubscription({
        accessToken: "tok",
        region: "us",
        deliveryUrl: SHARED_DELIVERY_URL,
        existingSubscriptionId: "PFTHIS",
        hasStoredSecret: false,
      }),
    ).resolves.toEqual({ id: "PFNEW", secret: "new-secret" })
    expect(deletedIds).toEqual(["PFTHIS"])
  })
})
