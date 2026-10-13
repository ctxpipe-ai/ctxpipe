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

  it("blocks approval when the bound organization cannot be displayed", () => {
    const onAllow = vi.fn()
    act(() => {
      root.render(
        <OAuthConsent
          clientId="claude-plugin"
          scopes={["openid"]}
          organization={null}
          onAllow={onAllow}
          onDeny={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain(
      "The organisation for this request could not be verified",
    )
    const allowButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Allow"),
    )
    expect(allowButton?.disabled).toBe(true)
    act(() => allowButton?.click())
    expect(onAllow).not.toHaveBeenCalled()
  })
  function renderWithScopes(scopes: string[], onAllow = vi.fn()) {
    act(() => {
      root.render(
        <OAuthConsent
          clientId="mcp-host"
          scopes={scopes}
          organization={{ name: "Acme", slug: "acme" }}
          onAllow={onAllow}
          onDeny={vi.fn()}
        />,
      )
    })
    return onAllow
  }

  function clickAllow() {
    const allowButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Allow"),
    )
    act(() => allowButton?.click())
  }

  it("leaves the write scope out unless the user ticks it", () => {
    const onAllow = renderWithScopes([
      "ctxpipe:read",
      "ctxpipe:write",
      "offline_access",
    ])

    const writeBox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    expect(writeBox?.checked).toBe(false)
    expect(container.textContent).toContain("Read context")
    clickAllow()
    expect(onAllow).toHaveBeenCalledWith(["ctxpipe:read", "offline_access"])
  })

  it("allows the write scope when the user ticks it", () => {
    const onAllow = renderWithScopes(["ctxpipe:read", "ctxpipe:write"])

    const writeBox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    act(() => writeBox?.click())
    expect(writeBox?.checked).toBe(true)
    clickAllow()
    expect(onAllow).toHaveBeenCalledWith(["ctxpipe:read", "ctxpipe:write"])
  })

  it("shows no write option when the client asks for read only", () => {
    const onAllow = renderWithScopes(["ctxpipe:read", "offline_access"])

    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    clickAllow()
    expect(onAllow).toHaveBeenCalledWith(["ctxpipe:read", "offline_access"])
  })
  it("blocks Allow for a write-only request until the user ticks write", () => {
    const onAllow = renderWithScopes(["ctxpipe:write"])

    expect(container.querySelector("ul")).toBeNull()
    const allowButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Allow"),
    )
    expect(allowButton?.disabled).toBe(true)
    clickAllow()
    expect(onAllow).not.toHaveBeenCalled()

    const writeBox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    act(() => writeBox?.click())
    clickAllow()
    expect(onAllow).toHaveBeenCalledWith(["ctxpipe:write"])
  })
})
