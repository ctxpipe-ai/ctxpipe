import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../../config/env.js"
import {
  exchangeLinearOAuthCode,
  getLinearOAuthAuthorizeUrl,
  linearOAuthRedirectUri,
  refreshLinearOAuthToken,
} from "./client.js"

const env = {
  AUTH_BASE_URL: "https://ctxpipe.example",
  LINEAR_CLIENT_ID: "linear-client",
  LINEAR_CLIENT_SECRET: "linear-secret",
} as Env

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Linear API client", () => {
  it("requests only read access through the fixed callback URL", () => {
    const url = new URL(
      getLinearOAuthAuthorizeUrl({ env, state: "signed-state" }),
    )
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize")
    expect(url.searchParams.get("scope")).toBe("read")
    expect(url.searchParams.get("state")).toBe("signed-state")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://ctxpipe.example/api/v1/integrations/linear/callback",
    )
    expect(linearOAuthRedirectUri(env)).toBe(
      "https://ctxpipe.example/api/v1/integrations/linear/callback",
    )
  })

  it("uses form encoding for code exchange and refresh-token rotation", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 86_399,
            token_type: "Bearer",
            scope: "read",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 86_399,
            token_type: "Bearer",
            scope: "read",
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)

    await exchangeLinearOAuthCode({ env, code: "oauth-code" })
    await refreshLinearOAuthToken({ env, refreshToken: "refresh-1" })

    const exchangeRequest = fetchMock.mock.calls[0]
    const refreshRequest = fetchMock.mock.calls[1]
    expect(exchangeRequest?.[0]).toBe("https://api.linear.app/oauth/token")
    expect(exchangeRequest?.[1]?.body?.toString()).toContain(
      "grant_type=authorization_code",
    )
    expect(exchangeRequest?.[1]?.body?.toString()).toContain(
      "client_secret=linear-secret",
    )
    expect(refreshRequest?.[1]?.body?.toString()).toContain(
      "grant_type=refresh_token",
    )
    expect(refreshRequest?.[1]?.body?.toString()).toContain(
      "refresh_token=refresh-1",
    )
  })
})
