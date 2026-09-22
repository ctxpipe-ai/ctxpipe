import { afterEach, describe, expect, it, vi } from "vitest"
import {
  fetchLinearConnectorConfig,
  fetchLinearConnectorStatus,
  fetchLinearOAuthStart,
  fetchLinearOauthApp,
  retryLinearConfig,
  retryLinearSync,
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
          isGithubLinked: true,
          selectedScopeCount: 1,
          setupPhase: "live",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          syncTarget: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    await fetchLinearConnectorStatus("acme", "con_linear")

    expect(fetchMock).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/linear/status?connectionId=con_linear",
      { credentials: "include" },
    )
  })

  it("returns git-backed scope from the config endpoint", async () => {
    const config = {
      scopes: [
        {
          externalId: "team-1",
          type: "team",
          title: "Engineering",
        },
      ],
      syncTarget: {
        repositoryId: "repo_1",
        repositoryName: "acme/context",
        githubConnectionId: "con_github",
        branch: "main",
        enabled: true,
        setupPhase: "live",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
      },
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(config), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )

    await expect(
      fetchLinearConnectorConfig("acme", "con_linear"),
    ).resolves.toEqual(config)
  })

  it("starts retry through the dedicated content endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)

    await retryLinearSync("acme", "con_linear")

    expect(fetchMock).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/linear/retry?connectionId=con_linear",
      { method: "POST", credentials: "include" },
    )
  })

  it("surfaces configuration retry API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "GitHub unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    )

    await expect(retryLinearConfig("acme", "con_linear")).rejects.toThrow(
      "GitHub unavailable",
    )
  })

  it("resubmits local scopes when retrying before a config PR exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    const scopes = [
      {
        externalId: "team-1",
        type: "team" as const,
        title: "Engineering",
      },
    ]

    await retryLinearConfig("acme", "con_linear", scopes)

    expect(fetchMock).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/linear/retry-config?connectionId=con_linear",
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes }),
      },
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
      { credentials: "include" },
    )
  })

  it("loads oauth-app metadata without echoing secrets", async () => {
    const body = {
      linearOauthConfigured: true,
      globalLinearOauthConfigured: false,
      oauthCallbackUrl: "https://app.example.com/api/v1/integrations/linear/callback",
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
    await expect(fetchLinearOauthApp("acme", "con_draft")).resolves.toEqual(body)
  })
})
