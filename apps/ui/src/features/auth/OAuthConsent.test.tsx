// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    href,
    isDisabled,
    onPress,
  }: {
    children: ReactNode
    href?: string
    isDisabled?: boolean
    onPress?: () => void
  }) =>
    href ? (
      <a href={href}>{children}</a>
    ) : (
      <button type="button" disabled={isDisabled} onClick={onPress}>
        {children}
      </button>
    ),
}))

vi.mock("@/components/ui/InlineAlert", () => ({
  InlineAlert: ({
    title,
    children,
  }: {
    title?: string
    children: ReactNode
  }) => (
    <div role="alert">
      {title}
      {children}
    </div>
  ),
}))

import { OAuthConsent } from "./OAuthConsent"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe("OAuthConsent", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("shows the bound organization and a signed-query change link", () => {
    act(() => {
      root.render(
        <OAuthConsent
          clientId="claude-plugin"
          scopes={["openid", "offline_access"]}
          organization={{
            name: "Consulting",
            slug: "consulting",
          }}
          changeOrganizationHref="/.auth/select-organization?client_id=claude-plugin&sig=abc.def"
          onAllow={vi.fn()}
          onDeny={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain("Consulting")
    expect(container.textContent).toContain("consulting")

    const changeLink = Array.from(container.querySelectorAll("a")).find(
      (anchor) => anchor.textContent?.includes("Change organisation"),
    )
    expect(changeLink?.getAttribute("href")).toBe(
      "/.auth/select-organization?client_id=claude-plugin&sig=abc.def",
    )
  })

  it("hides the change link when only one organization can be bound", () => {
    act(() => {
      root.render(
        <OAuthConsent
          clientId="claude-plugin"
          scopes={["openid"]}
          organization={{ name: "Acme", slug: "acme" }}
          onAllow={vi.fn()}
          onDeny={vi.fn()}
        />,
      )
    })

    expect(
      Array.from(container.querySelectorAll("a")).some((anchor) =>
        anchor.textContent?.includes("Change organisation"),
      ),
    ).toBe(false)
  })
})
