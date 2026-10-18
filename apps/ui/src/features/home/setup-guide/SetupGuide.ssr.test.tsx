import { renderToString } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SetupGuideSkeleton } from "./SetupGuide"

describe("the editor step on the server", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("holds no URL of the server config in its HTML", () => {
    // On the hosted UI service, `AUTH_BASE_URL` is the private backend URL.
    vi.stubEnv("AUTH_BASE_URL", "http://backend.internal.example:8080")
    const html = renderToString(<SetupGuideSkeleton collapsed={false} />)
    expect(html).toContain("Use ctx| from your agents")
    expect(html).not.toContain("backend.internal.example")
    expect(html).not.toContain("localhost:3000")
    expect(html).not.toContain("--base-url")
    expect(html).not.toContain("/mcp</")
  })
})
