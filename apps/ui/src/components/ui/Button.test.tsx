// @vitest-environment jsdom

import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

const renderProps = {
  isHovered: false,
  isPressed: false,
  isFocused: false,
  isFocusVisible: false,
  isDisabled: false,
  isPending: false,
}

vi.mock("react-aria-components", () => ({
  composeRenderProps: (
    value: ReactNode,
    callback: (value: ReactNode, props: typeof renderProps) => ReactNode,
  ) => callback(value, renderProps),
  Button: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => <button {...props}>{children}</button>,
  Link: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => <a {...props}>{children}</a>,
}))

import { Button } from "./Button"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe("Button", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("renders an anchor when href is provided", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <Button
          href="https://github.com/acme/context/pull/1"
          target="_blank"
          rel="noopener noreferrer"
        >
          Open pull request
        </Button>,
      )
    })

    const link = container.querySelector("a")
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/acme/context/pull/1",
    )
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(container.querySelector("button")).toBeNull()

    await act(async () => root.unmount())
  })
})
