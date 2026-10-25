import { afterEach, describe, expect, it, vi } from "vitest"

import {
  fetchLinearConnectorStatus,
  fetchLinearOAuthStart,
  fetchLinearOauthApp,
} from "./linear-connector"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Linear connector API", () => {
  it("scopes status requests to a specific connection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          isInstalled: true,
          installationStatus: "installed",
          workspaceName: "Acme",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    await fetchLinearConnectorStatus("acme", "con_linear")

    expect(fetchMock).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/linear/status?connectionId=con_linear",
      expect.objectContaining({ credentials: "include" }),
    )
  })

  it("passes connectionId when starting OAuth from a draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authorizationUrl: "https://linear.app" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    await fetchLinearOAuthStart("acme", "con_draft")
    expect(fetchMock).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/linear/oauth/start?connectionId=con_draft",
      expect.objectContaining({ credentials: "include" }),
    )
  })

  it("loads oauth-app metadata without echoing secrets", async () => {
    const body = {
      linearOauthConfigured: true,
      globalLinearOauthConfigured: false,
      oauthCallbackUrl:
        "https://app.example.com/api/v1/integrations/linear/callback",
      linearWebhookUrl: "https://app.example.com/api/v1/webhook/linear",
      linearCreateUrl: "https://linear.app/settings/api/applications/new",
      oauthAppSaved: true,
      oauthClientId: "lin_client",
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
    await expect(fetchLinearOauthApp("acme", "con_draft")).resolves.toEqual(
      body,
    )
  })
})
