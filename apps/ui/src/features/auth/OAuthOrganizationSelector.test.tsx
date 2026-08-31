// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let radioGroupOnChange: ((value: string) => void) | undefined

vi.mock("@/components/ui/RadioGroup", () => ({
  RadioGroup: ({
    children,
    onChange,
  }: {
    children: ReactNode
    onChange?: (value: string) => void
  }) => {
    radioGroupOnChange = onChange
    return <div>{children}</div>
  },
  Radio: ({ children, value }: { children: ReactNode; value: string }) => (
    <button
      type="button"
      role="radio"
      onClick={() => radioGroupOnChange?.(value)}
    >
      {children}
    </button>
  ),
}))

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
    actions,
  }: {
    title?: string
    children: ReactNode
    actions?: ReactNode
  }) => (
    <div role="alert">
      {title}
      {children}
      {actions}
    </div>
  ),
}))

import { OAuthOrganizationSelector } from "./OAuthOrganizationSelector"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe("OAuthOrganizationSelector", () => {
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

  it("requires an explicit organization choice before continuing", () => {
    const onContinue = vi.fn()
    act(() => {
      root.render(
        <OAuthOrganizationSelector
          organizations={[
            { id: "org_acme", name: "Acme", slug: "acme" },
            {
              id: "org_consulting",
              name: "Consulting",
              slug: "consulting",
            },
          ]}
          onContinue={onContinue}
        />,
      )
    })

    const continueButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Continue"))
    expect(continueButton).toBeDefined()
    expect(continueButton?.disabled).toBe(true)

    const consultingChoice = Array.from(
      container.querySelectorAll('[role="radio"]'),
    ).find((radio) => radio.textContent?.includes("Consulting"))
    expect(consultingChoice).toBeDefined()

    act(() => {
      consultingChoice?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      )
    })
    expect(continueButton?.disabled).toBe(false)

    act(() => {
      continueButton?.click()
    })
    expect(onContinue).toHaveBeenCalledWith("org_consulting")
  })

  it("directs users without memberships to organization setup", () => {
    act(() => {
      root.render(
        <OAuthOrganizationSelector organizations={[]} onContinue={vi.fn()} />,
      )
    })

    expect(container.textContent).toContain("No organizations available")
    expect(
      container.querySelector('a[href="/onboarding"]'),
    ).not.toBeNull()
  })
})
