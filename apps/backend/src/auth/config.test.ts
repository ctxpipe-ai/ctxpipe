import { afterEach, describe, expect, it, vi } from "vitest"
import { createBetterAuth } from "./config.js"

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
