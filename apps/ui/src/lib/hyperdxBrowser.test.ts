import HyperDX from "@hyperdx/browser"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearHyperDxGlobalAttributes,
  initHyperDxBrowser,
  setHyperDxGlobalAttributes,
} from "./hyperdxBrowser"

// `@hyperdx/browser` `init` registers global fetch/xhr instrumentation and does
// not accept an in-memory span exporter. The spy replaces `init` only.
// `setGlobalAttributes` is the real method (a no-op until init); the spy records it.

describe("HyperDX browser attributes", () => {
  afterEach(() => {
    clearHyperDxGlobalAttributes()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("inits without tracePropagationTargets and stamps the server identity", () => {
    const init = vi.spyOn(HyperDX, "init").mockImplementation(() => {})
    const setGlobalAttributes = vi.spyOn(HyperDX, "setGlobalAttributes")
    vi.stubGlobal("window", { location: { origin: "https://app.example" } })

    initHyperDxBrowser(
      { enabled: true, environment: "pr-1" },
      { userId: "user_1", teamId: "org_1", teamName: "acme" },
    )

    expect(init).toHaveBeenCalledTimes(1)
    const options = init.mock.calls[0]?.[0]
    expect(options).toMatchObject({
      url: "https://app.example/.otel",
      service: "ui",
      apiKey: "proxy",
      disableReplay: true,
      otelResourceAttributes: {
        "service.namespace": "ctxpipe",
        "deployment.environment": "pr-1",
      },
    })
    expect(options).not.toHaveProperty("tracePropagationTargets")
    expect(options?.ignoreUrls?.[0]).toBeInstanceOf(RegExp)
    expect(
      (options?.ignoreUrls?.[0] as RegExp).test(
        "https://app.example/.otel/v1/traces",
      ),
    ).toBe(true)
    expect(
      (options?.ignoreUrls?.[0] as RegExp).test(
        "https://app.example/acme/api/v1/repositories",
      ),
    ).toBe(false)
    expect(setGlobalAttributes).toHaveBeenCalledWith({
      userId: "user_1",
      teamId: "org_1",
      teamName: "acme",
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
    })
  })

  it("clears with null before publishing a different set, and skips an unchanged set", () => {
    const setGlobalAttributes = vi.spyOn(HyperDX, "setGlobalAttributes")
    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "org_1",
      teamName: "acme",
    })
    setGlobalAttributes.mockClear()

    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "org_2",
      teamName: "beta",
    })
    expect(setGlobalAttributes).toHaveBeenNthCalledWith(1, null)
    expect(setGlobalAttributes).toHaveBeenNthCalledWith(2, {
      userId: "user_1",
      teamId: "org_2",
      teamName: "beta",
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_2",
      "ctxpipe.org.slug": "beta",
    })

    setGlobalAttributes.mockClear()
    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "org_2",
      teamName: "beta",
    })
    expect(setGlobalAttributes).not.toHaveBeenCalled()
  })

  it("omits org keys for an auth-page identity and sign-out clears", () => {
    const setGlobalAttributes = vi.spyOn(HyperDX, "setGlobalAttributes")
    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "org_1",
      teamName: "acme",
    })
    setGlobalAttributes.mockClear()

    setHyperDxGlobalAttributes({ userId: "user_1", teamId: "", teamName: "" })
    expect(setGlobalAttributes).toHaveBeenNthCalledWith(1, null)
    expect(setGlobalAttributes).toHaveBeenNthCalledWith(2, {
      userId: "user_1",
      "enduser.id": "user_1",
    })

    setGlobalAttributes.mockClear()
    clearHyperDxGlobalAttributes()
    expect(setGlobalAttributes).toHaveBeenCalledWith(null)
  })
})
