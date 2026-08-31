// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
