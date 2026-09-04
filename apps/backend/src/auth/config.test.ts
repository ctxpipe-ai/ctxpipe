import { afterEach, describe, expect, it, vi } from "vitest"
import { API_KEY_RATE_LIMIT, createBetterAuth } from "./config.js"

type OAuthProviderOptions = {
  postLogin?: {
    page?: string
    shouldRedirect?: (...args: never[]) => unknown
    consentReferenceId?: (...args: never[]) => unknown
  }
  customAccessTokenClaims?: (input: {
    referenceId?: string
  }) => Promise<Record<string, unknown>> | Record<string, unknown>
}

describe("createBetterAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("raises API-key rate limits to 1000 requests per hour", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/ctxpipe")
    vi.stubEnv(
      "AUTH_SECRET",
      "test-only-auth-secret-with-at-least-32-characters",
    )
    vi.stubEnv("AUTH_BASE_URL", "http://localhost:3000")

    const auth = createBetterAuth()
    const apiKeyPlugin = auth.options.plugins?.find(
      (plugin) => plugin.id === "api-key",
    )

    expect(apiKeyPlugin).toBeDefined()
    expect(API_KEY_RATE_LIMIT).toEqual({
      enabled: true,
      timeWindow: 60 * 60 * 1000,
      maxRequests: 1000,
    })
    expect(apiKeyPlugin?.id).toBe("api-key")
  })

  it("allows emailed invitations with opaque custom IDs to be accepted", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/ctxpipe")
    vi.stubEnv(
      "AUTH_SECRET",
      "test-only-auth-secret-with-at-least-32-characters",
    )
    vi.stubEnv("AUTH_BASE_URL", "http://localhost:3000")

    const auth = createBetterAuth()
    const organizationPlugin = auth.options.plugins?.find(
      (plugin) => plugin.id === "organization",
    )

    expect(organizationPlugin).toBeDefined()
    expect(organizationPlugin?.options).toMatchObject({
      requireEmailVerificationOnInvitation: false,
    })
  })

  it("binds OAuth access tokens to an organization selected before consent", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/ctxpipe")
    vi.stubEnv(
      "AUTH_SECRET",
      "test-only-auth-secret-with-at-least-32-characters",
    )
    vi.stubEnv("AUTH_BASE_URL", "http://localhost:3000")

    const auth = createBetterAuth()
    const oauthPlugin = auth.options.plugins?.find(
      (plugin) => plugin.id === "oauth-provider",
    )
    const options = oauthPlugin?.options as OAuthProviderOptions | undefined

    expect(options?.postLogin).toMatchObject({
      page: "/.auth/select-organization",
      shouldRedirect: expect.any(Function),
      consentReferenceId: expect.any(Function),
    })
    expect(
      await options?.customAccessTokenClaims?.({
        referenceId: "org_acme",
      }),
    ).toEqual({
      "https://ctxpipe.ai/organization_id": "org_acme",
    })
  })
})
