// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const organizationViewMock = vi.hoisted(() =>
  vi.fn((props: { pathname?: string; hideNav?: boolean }) => (
    <div
      data-testid="organization-view"
      data-pathname={props.pathname}
      data-hide-nav={props.hideNav ? "true" : "false"}
    />
  )),
)

vi.mock("@daveyplate/better-auth-ui", () => ({
  OrganizationView: organizationViewMock,
}))

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({ component: () => null }),
  Navigate: () => null,
  Link: ({
    children,
    params,
  }: {
    children: ReactNode
    params?: { organizationView?: string }
  }) => (
    <a href={`/${params?.organizationView ?? ""}`} data-testid="nav-link">
      {children}
    </a>
  ),
}))

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: null, isPending: false }),
  useListOrganizations: () => ({ data: [], isPending: false }),
}))

vi.mock("@/features/organization/OrganizationApiKeysCard", () => ({
  OrganizationApiKeysCard: ({ organizationId }: { organizationId: string }) => (
    <div data-testid="org-api-keys-card">{organizationId}</div>
  ),
}))

import { OrganizationSettingsBody } from "./$orgSlug.organization.$organizationView"

describe("OrganizationSettingsBody", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    organizationViewMock.mockClear()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it("shows API Keys in the sidebar on settings and hides Better Auth nav", () => {
    act(() => {
      root.render(
        <OrganizationSettingsBody
          orgSlug="acme"
          organizationView="settings"
          organizationId="org_acme"
        />,
      )
    })

    const nav = container.querySelector(
      'nav[aria-label="Organisation settings"]',
    )
    expect(nav?.textContent).toContain("Settings")
    expect(nav?.textContent).toContain("Members")
    expect(nav?.textContent).toContain("API Keys")

    const view = container.querySelector('[data-testid="organization-view"]')
    expect(view?.getAttribute("data-pathname")).toBe("settings")
    expect(view?.getAttribute("data-hide-nav")).toBe("true")
  })

  it("keeps the shared sidebar on the api-keys view", () => {
    act(() => {
      root.render(
        <OrganizationSettingsBody
          orgSlug="acme"
          organizationView="api-keys"
          organizationId="org_acme"
        />,
      )
    })

    const nav = container.querySelector(
      'nav[aria-label="Organisation settings"]',
    )
    expect(nav?.textContent).toContain("API Keys")
    expect(
      container.querySelector('[data-testid="org-api-keys-card"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="organization-view"]'),
    ).toBeNull()
  })
})
