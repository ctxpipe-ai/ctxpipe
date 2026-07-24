import { describe, expect, it } from "vitest"
import type { Env } from "../config/env.js"
import {
  canonicalResourceForValidAudiences,
  prepareBetterAuthRequest,
  redactOAuthParams,
} from "./oauth-gateway-request.js"

function mockEnv(baseUrl: string): Env {
  return {
    AUTH_BASE_URL: baseUrl,
    AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
    DATABASE_URL: "postgres://localhost:5432/ctxpipe",
    NODE_ENV: "test",
    PORT: 3000,
    UI_PROXY_URL: "http://localhost:3002",
    GRAPH_DB_URI: "redis://localhost:6379",
    GRAPH_DB_PROVIDER: "falkordb",
  } as Env
}

describe("canonicalResourceForValidAudiences", () => {
  const env = mockEnv("https://app.example.com")

  it("maps MCP URL with query to canonical audience string", () => {
    expect(
      canonicalResourceForValidAudiences(
        new URL("https://app.example.com/mcp?orgSlug=org-a"),
        env,
      ),
    ).toBe("https://app.example.com/mcp")
  })

  it("returns AUTH_BASE_URL when path matches base URL path", () => {
    expect(
      canonicalResourceForValidAudiences(
        new URL("https://app.example.com"),
        env,
      ),
    ).toBe("https://app.example.com")
    expect(
      canonicalResourceForValidAudiences(
        new URL("https://app.example.com?x=1"),
        env,
      ),
    ).toBe("https://app.example.com")
  })

  it("returns null for wrong origin", () => {
    expect(
      canonicalResourceForValidAudiences(
        new URL("https://evil.example/mcp"),
        env,
      ),
    ).toBeNull()
  })

  it("treats /mcp/ like /mcp", () => {
    expect(
      canonicalResourceForValidAudiences(
        new URL("https://app.example.com/mcp/?org=x"),
        env,
      ),
    ).toBe("https://app.example.com/mcp")
  })
})

describe("prepareBetterAuthRequest", () => {
  it("rewrites resource on oauth2/token form body", async () => {
    const env = mockEnv("https://app.example.com")
    const req = new Request(
      "https://app.example.com/.auth/api/v1/auth/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          resource: "https://app.example.com/mcp?orgSlug=z",
          refresh_token: "rt-secret",
          client_id: "pub-client",
        }).toString(),
      },
    )

    const { request, oauthTokenHints } = await prepareBetterAuthRequest(
      req,
      env,
    )

    expect(oauthTokenHints?.grant_type).toBe("refresh_token")
    expect(oauthTokenHints?.client_id).toBe("pub-client")

    const body = await request.text()
    const paramsOut = new URLSearchParams(body)
    expect(paramsOut.get("resource")).toBe("https://app.example.com/mcp")
    expect(paramsOut.get("grant_type")).toBe("refresh_token")
    expect(paramsOut.get("client_id")).toBe("pub-client")

    expect(oauthTokenHints?.redacted_request_body?.grant_type).toBe(
      "refresh_token",
    )
    expect(oauthTokenHints?.redacted_request_body?.resource).toBe(
      "https://app.example.com/mcp",
    )
    expect(oauthTokenHints?.redacted_request_body?.refresh_token_present).toBe(
      true,
    )
    expect(oauthTokenHints?.redacted_request_body?.refresh_token_len).toBe(9)
    expect(
      oauthTokenHints?.redacted_request_body?.refresh_token,
    ).toBeUndefined()
  })

  it("does not touch non-token routes", async () => {
    const env = mockEnv("https://app.example.com")
    const req = new Request(
      "https://app.example.com/.auth/api/v1/auth/session",
      {
        method: "GET",
      },
    )
    const { request } = await prepareBetterAuthRequest(req, env)
    expect(request).toBe(req)
  })
})

describe("redactOAuthParams", () => {
  it("replaces sensitive values with presence and length", () => {
    const r = redactOAuthParams(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "abc123secret",
        client_id: "cid",
      }),
    )
    expect(r.grant_type).toBe("refresh_token")
    expect(r.client_id).toBe("cid")
    expect(r.refresh_token_present).toBe(true)
    expect(r.refresh_token_len).toBe(12)
    expect(r.refresh_token).toBeUndefined()
  })
})
