import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/connection-config.js", () => ({
  decodeSlackBotToken: () => "xoxb-test",
  parseSlackConnectionStored: () => ({}),
}))

import { listSlackChannelsForBot } from "./client.js"

const fetchMock = vi.fn()

describe("listSlackChannelsForBot", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("lists public channels before invite and member private channels", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          channels: [
            {
              id: "C_PUBLIC",
              name: "general",
              is_private: false,
              is_member: false,
            },
            {
              id: "C_PRIVATE",
              name: "leadership",
              is_private: true,
              is_member: true,
            },
            {
              id: "C_HIDDEN",
              name: "hidden",
              is_private: true,
              is_member: false,
            },
          ],
          response_metadata: { next_cursor: "" },
        }),
        { status: 200 },
      ),
    )

    await expect(
      listSlackChannelsForBot({
        env: {} as never,
        connection: {} as never,
      }),
    ).resolves.toEqual([
      {
        id: "C_PUBLIC",
        name: "general",
        isPrivate: false,
        isMember: false,
      },
      {
        id: "C_PRIVATE",
        name: "leadership",
        isPrivate: true,
        isMember: true,
      },
    ])

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(requestUrl.pathname).toBe("/api/conversations.list")
    expect(requestUrl.searchParams.get("types")).toBe(
      "public_channel,private_channel",
    )
  })

  it("preserves Slack API error codes for callers", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
        status: 200,
      }),
    )

    await expect(
      listSlackChannelsForBot({
        env: {} as never,
        connection: {} as never,
      }),
    ).rejects.toMatchObject({
      slackError: "missing_scope",
    })
  })
})
