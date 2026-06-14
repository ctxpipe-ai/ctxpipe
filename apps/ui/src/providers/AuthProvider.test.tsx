import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
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

  it("enables built-in API key UI in provider config", async () => {
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
      }),
    )
  })
})
