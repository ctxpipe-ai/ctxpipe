import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchSlackAvailableChannels } from "./slack-connector"

describe("fetchSlackAvailableChannels", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("preserves membership state for discoverable public channels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "C1",
                name: "general",
                isPrivate: false,
                isMember: false,
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    )

    await expect(fetchSlackAvailableChannels("acme", "con_1")).resolves.toEqual(
      [
        {
          id: "C1",
          name: "general",
          isPrivate: false,
          isMember: false,
        },
      ],
    )
  })

  it("surfaces actionable channel discovery errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              "Slack app is missing required channel scopes. Reconnect Slack and try again.",
          }),
          { status: 502 },
        ),
      ),
    )

    await expect(fetchSlackAvailableChannels("acme", "con_1")).rejects.toThrow(
      "missing required channel scopes",
    )
  })
})
