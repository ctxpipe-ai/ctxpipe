// @vitest-environment jsdom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { TechnicalDetail } from "./TechnicalDetail"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

async function render(node: React.ReactNode) {
  const container = document.createElement("div")
  document.body.append(container)
  await act(async () => {
    createRoot(container).render(node)
  })
  return container
}

describe("TechnicalDetail", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("hides the secret-like values of a raw reason", async () => {
    const container = await render(
      <TechnicalDetail>
        {
          "clone failed: https://x-access-token:ghs_0123456789abcdefghijklmnopqrstuvwxyz@github.com/acme/docs.git?token=abc123"
        }
      </TechnicalDetail>,
    )
    expect(container.textContent).not.toContain("ghs_0123456789")
    expect(container.textContent).not.toContain("abc123")
    expect(container.textContent).toContain("clone failed")
  })

  it("keeps text without secrets as it is", async () => {
    const container = await render(
      <TechnicalDetail>{"HTTP 502 from the sandbox"}</TechnicalDetail>,
    )
    expect(container.textContent).toBe("HTTP 502 from the sandbox")
  })
})
