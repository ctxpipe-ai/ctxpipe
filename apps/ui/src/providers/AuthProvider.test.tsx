import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const useRouterMock = vi.fn()
const useGetAuthConfigMock = vi.fn()
const useAuthEvlogIdentityMock = vi.fn()
const authQueryProviderMock = vi.fn()
const authUiProviderTanstackMock = vi.fn()

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
  useRouter: useRouterMock,
}))

vi.mock("@/lib/useGetAuthConfig", () => ({
  useGetAuthConfig: useGetAuthConfigMock,
}))

vi.mock("@/lib/useAuthEvlogIdentity", () => ({
  useAuthEvlogIdentity: useAuthEvlogIdentityMock,
}))

vi.mock("@daveyplate/better-auth-tanstack", () => ({
  AuthQueryProvider: ({ children }: { children?: ReactNode }) => {
    authQueryProviderMock()
    return children
  },
}))

vi.mock("@daveyplate/better-auth-ui/tanstack", () => ({
  AuthUIProviderTanstack: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => {
    authUiProviderTanstackMock(props)
    return children
  },
}))

describe("AuthProvider", () => {
  beforeEach(() => {
    useRouterMock.mockReset()
    useGetAuthConfigMock.mockReset()
    useAuthEvlogIdentityMock.mockReset()
    authQueryProviderMock.mockReset()
    authUiProviderTanstackMock.mockReset()

    useRouterMock.mockReturnValue({
      state: { location: { pathname: "/.auth/account/security" } },
      invalidate: vi.fn(),
    })
    useGetAuthConfigMock.mockReturnValue({ data: { providers: [] } })
  })

  it("enables personal API key UI but disables organisation API keys in provider config", async () => {
    // User settings = personal keys only. better-auth-ui's CreateApiKeyDialog
    // gates its organisation/personal selector on contextOrganization.apiKey;
    // leaving it true would let users mint org keys from /.auth/account/api-keys.
    // Org key minting lives in features/organization/OrganizationApiKeysCard.
    const { AuthProvider } = await import("./AuthProvider")

    renderToStaticMarkup(
      <AuthProvider>
        <div>content</div>
      </AuthProvider>,
    )

    expect(useAuthEvlogIdentityMock).toHaveBeenCalledTimes(1)
    expect(authQueryProviderMock).toHaveBeenCalledTimes(1)
    expect(authUiProviderTanstackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: true,
        basePath: "/.auth",
        account: { basePath: "/.auth/account" },
        organization: {
          basePath: "/.auth/organization",
          apiKey: false,
        },
      }),
    )
  })

  it("keeps organisation API keys disabled even when an org slug is in the path", async () => {
    // The custom OrganizationApiKeysCard handles org keys directly via the
    // authClient with configId: "organization", so we don't need the library's
    // org-side UI and we keep the dropdown suppressed.
    useRouterMock.mockReturnValue({
      state: { location: { pathname: "/acme/organization/members" } },
      invalidate: vi.fn(),
    })
    const { AuthProvider } = await import("./AuthProvider")

    renderToStaticMarkup(
      <AuthProvider>
        <div>content</div>
      </AuthProvider>,
    )

    expect(authUiProviderTanstackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: true,
        organization: {
          slug: "acme",
          basePath: "/.auth/organization",
          apiKey: false,
        },
      }),
    )
  })

  it("never enables the organisation API-key flag under any pathname", async () => {
    // Regression: better-auth-ui's CreateApiKeyDialog gates its
    // organisation/personal selector on contextOrganization.apiKey. If this
    // ever flips back to true, users can mint org keys from /.auth/account.
    const { AuthProvider } = await import("./AuthProvider")
    const pathnames = [
      "/.auth/account/security",
      "/.auth/account/api-keys",
      "/.auth/organization/settings",
      "/acme/organization/members",
      "/acme/organization/api-keys",
    ]
    for (const pathname of pathnames) {
      useRouterMock.mockReturnValue({
        state: { location: { pathname } },
        invalidate: vi.fn(),
      })
      renderToStaticMarkup(
        <AuthProvider>
          <div>content</div>
        </AuthProvider>,
      )
    }
    for (const call of authUiProviderTanstackMock.mock.calls) {
      const props = call[0] as { organization?: { apiKey?: unknown } }
      expect(props.organization?.apiKey).toBe(false)
    }
  })
})
