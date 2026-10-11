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
      { enabled: true },
      { userId: "user_1", teamId: "org_1", teamName: "acme" },
    )

    expect(init).toHaveBeenCalledTimes(1)
    const options = init.mock.calls[0]?.[0]
    expect(options).toMatchObject({
      url: "https://app.example/.otel",
      service: "ui",
      apiKey: "proxy",
      disableReplay: true,
    })
    expect(options).not.toHaveProperty("tracePropagationTargets")
    expect(options).not.toHaveProperty("otelResourceAttributes")
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
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_1",
      "ctxpipe.org.slug": "acme",
    })
  })

  it("publishes the full attribute bag, with empty strings for missing ids", () => {
    const setGlobalAttributes = vi.spyOn(HyperDX, "setGlobalAttributes")
    setHyperDxGlobalAttributes({
      userId: "user_1",
      teamId: "",
      teamName: "",
    })
    expect(setGlobalAttributes).toHaveBeenCalledWith({
      "enduser.id": "user_1",
      "ctxpipe.org.id": "",
      "ctxpipe.org.slug": "",
    })
  })

  it("clears by publishing an empty bag", () => {
    const setGlobalAttributes = vi.spyOn(HyperDX, "setGlobalAttributes")
    clearHyperDxGlobalAttributes()
    expect(setGlobalAttributes).toHaveBeenCalledWith({
      "enduser.id": "",
      "ctxpipe.org.id": "",
      "ctxpipe.org.slug": "",
    })
  })

  it("keeps a screen error recorded before init and sends it at init", async () => {
    vi.resetModules()
    const fresh = await import("./hyperdxBrowser")
    const { default: FreshHyperDX } = await import("@hyperdx/browser")
    vi.spyOn(FreshHyperDX, "init").mockImplementation(() => {})
    const recordException = vi.spyOn(FreshHyperDX, "recordException")
    vi.stubGlobal("window", { location: { origin: "https://app.example" } })

    fresh.recordHyperDxScreenError("org_access_denied", {
      route: "/$orgSlug",
      path: "/no-such-org",
    })
    expect(recordException).not.toHaveBeenCalled()

    fresh.initHyperDxBrowser({ enabled: true }, null)
    fresh.initHyperDxBrowser({ enabled: true }, null)
    expect(FreshHyperDX.init).toHaveBeenCalledTimes(1)
    expect(recordException).toHaveBeenCalledTimes(1)
    const [error, attributes] = recordException.mock.calls[0] ?? []
    expect((error as Error).message).toBe("UI screen: org_access_denied")
    expect(attributes).toEqual({
      "ctxpipe.ui.source": "screen",
      "ctxpipe.ui.screen": "org_access_denied",
      route: "/$orgSlug",
      "url.path": "/no-such-org",
    })

    fresh.recordHyperDxScreenError("workspace_not_found", {
      route: "/$orgSlug/ws/$workspaceSlug",
      path: "/acme/ws/no-such-ws",
    })
    expect(recordException).toHaveBeenCalledTimes(2)
  })
})
