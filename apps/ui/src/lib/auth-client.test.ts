import { beforeEach, describe, expect, it, vi } from "vitest"

const createAuthClientMock = vi.fn(() => ({}))
const apiKeyClientMock = vi.fn(() => "apiKeyPlugin")
const deviceAuthorizationClientMock = vi.fn(() => "deviceAuthorizationPlugin")
const organizationClientMock = vi.fn(() => "organizationPlugin")
const twoFactorClientMock = vi.fn(() => "twoFactorPlugin")
const oauthProviderClientMock = vi.fn(() => "oauthProviderPlugin")

vi.mock("better-auth/react", () => ({
  createAuthClient: createAuthClientMock,
}))

vi.mock("better-auth/client/plugins", () => ({
  deviceAuthorizationClient: deviceAuthorizationClientMock,
  organizationClient: organizationClientMock,
  twoFactorClient: twoFactorClientMock,
}))

vi.mock("@better-auth/oauth-provider/client", () => ({
  oauthProviderClient: oauthProviderClientMock,
}))

vi.mock("@better-auth/api-key/client", () => ({
  apiKeyClient: apiKeyClientMock,
}))

describe("authClient", () => {
  beforeEach(() => {
    vi.resetModules()
    createAuthClientMock.mockClear()
    apiKeyClientMock.mockClear()
    deviceAuthorizationClientMock.mockClear()
    organizationClientMock.mockClear()
    twoFactorClientMock.mockClear()
    oauthProviderClientMock.mockClear()
  })

  it("includes oauthProviderClient to preserve OAuth flow query", async () => {
    await import("./auth-client")

    expect(createAuthClientMock).toHaveBeenCalledTimes(1)
    expect(createAuthClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        basePath: "/.auth/api/v1/auth",
        plugins: [
          "apiKeyPlugin",
          "organizationPlugin",
          "twoFactorPlugin",
          "deviceAuthorizationPlugin",
          "oauthProviderPlugin",
        ],
      }),
    )
  })
})
