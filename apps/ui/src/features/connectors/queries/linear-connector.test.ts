import { afterEach, describe, expect, it, vi } from "vitest"
import {
  fetchLinearConnectorStatus,
  retryLinearConfig,
  retryLinearSync,
} from "./linear-connector"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Linear connector API", () => {
  it("scopes status requests to a specific connection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          isInstalled: true,
          installationStatus: "installed",
          workspaceName: "Acme",
          isGithubLinked: true,
          selectedScopeCount: 1,
          setupPhase: "live",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          syncTarget: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)

    await fetchLinearConnectorStatus("acme", "con_linear")

    expect(fetchMock).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/linear/status?connectionId=con_linear",
      { credentials: "include" },
    )
  })

  it("starts retry through the dedicated content endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)

    await retryLinearSync("acme", "con_linear")

    expect(fetchMock).toHaveBeenCalledWith(
      "/acme/api/v1/connectors/linear/retry?connectionId=con_linear",
      { method: "POST", credentials: "include" },
    )
  })

  it("surfaces configuration retry API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "GitHub unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    )

    await expect(retryLinearConfig("acme", "con_linear")).rejects.toThrow(
      "GitHub unavailable",
    )
  })
})
