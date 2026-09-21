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

  it("enables organisation API-key navigation only inside organisation settings", async () => {
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
          apiKey: true,
        },
      }),
    )
  })

  it("keeps the organisation key selector out of personal account routes", async () => {
    const { AuthProvider } = await import("./AuthProvider")
    const cases = [
      { pathname: "/.auth/account/security", apiKey: false },
      { pathname: "/.auth/account/api-keys", apiKey: false },
      { pathname: "/acme/organization/members", apiKey: true },
      { pathname: "/acme/organization/api-keys", apiKey: true },
    ]
    for (const { pathname } of cases) {
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
    for (const [
      index,
      call,
    ] of authUiProviderTanstackMock.mock.calls.entries()) {
      const props = call[0] as { organization?: { apiKey?: unknown } }
      expect(props.organization?.apiKey).toBe(cases[index]?.apiKey)
    }
  })
})
