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
      userId: "user_1",
      teamId: "org_1",
      teamName: "acme",
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
      userId: "user_1",
      teamId: "",
      teamName: "",
      "enduser.id": "user_1",
      "ctxpipe.org.id": "",
      "ctxpipe.org.slug": "",
    })
  })

  it("clears by publishing an empty bag", () => {
    const setGlobalAttributes = vi.spyOn(HyperDX, "setGlobalAttributes")
    clearHyperDxGlobalAttributes()
    expect(setGlobalAttributes).toHaveBeenCalledWith({
      userId: "",
      teamId: "",
      teamName: "",
      "enduser.id": "",
      "ctxpipe.org.id": "",
      "ctxpipe.org.slug": "",
    })
  })
})
