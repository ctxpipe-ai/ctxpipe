import { HttpResponse, http } from "msw"
import { describe, expect, it } from "vitest"

import { useMswServer } from "../../../test/msw.js"
import type { Env } from "../../config/env.js"
import { encodeSlackBotTokenForDb } from "../../lib/connection-config.js"
import type { SlackConnectionShape } from "../../models/connection-rows.js"
import { listSlackChannels } from "./client.js"

const server = useMswServer()

describe("listSlackChannels", () => {
  it("lists every page, leaves out archived channels, and sorts by name", async () => {
    const env = { AUTH_SECRET: "a-test-secret-of-at-least-32-chars!" } as Env
    const requests: URLSearchParams[] = []
    server.use(
      http.get("https://slack.com/api/conversations.list", ({ request }) => {
        const query = new URL(request.url).searchParams
        requests.push(query)
        return HttpResponse.json(
          query.get("cursor")
            ? {
                ok: true,
                channels: [
                  { id: "G0PRIV001", name: "incidents", is_private: true },
                  { id: "C0OLD0001", name: "old", is_archived: true },
                ],
              }
            : {
                ok: true,
                channels: [
                  { id: "C0ENG0001", name: "eng", is_member: true },
                  { id: "C0ALL0001", name: "all-hands", is_member: false },
                ],
                response_metadata: { next_cursor: "page-2" },
              },
        )
      }),
    )
    const connection = {
      id: "con_slack1",
      orgId: "org_1",
      botTokenEnc: encodeSlackBotTokenForDb("xoxb-test", env),
      status: "installed",
    } as SlackConnectionShape
    expect(await listSlackChannels({ env, connection })).toEqual({
      items: [
        {
          id: "C0ALL0001",
          name: "all-hands",
          isPrivate: false,
          isMember: false,
        },
        { id: "C0ENG0001", name: "eng", isPrivate: false, isMember: true },
        { id: "G0PRIV001", name: "incidents", isPrivate: true, isMember: true },
      ],
      truncated: false,
    })
    expect(requests.map((query) => query.get("types"))).toEqual([
      "public_channel,private_channel",
      "public_channel,private_channel",
    ])
  })

  it("stops at 2000 channels and says that the list is not complete", async () => {
    const env = { AUTH_SECRET: "a-test-secret-of-at-least-32-chars!" } as Env
    let page = 0
    server.use(
      http.get("https://slack.com/api/conversations.list", () => {
        page += 1
        return HttpResponse.json({
          ok: true,
          channels: Array.from({ length: 200 }, (_, index) => ({
            id: `C0P${String(page).padStart(2, "0")}${String(index).padStart(4, "0")}`,
            name: `channel-${page}-${index}`,
            is_member: true,
          })),
          response_metadata: { next_cursor: `page-${page + 1}` },
        })
      }),
    )
    const connection = {
      id: "con_slack1",
      orgId: "org_1",
      botTokenEnc: encodeSlackBotTokenForDb("xoxb-test", env),
      status: "installed",
    } as SlackConnectionShape
    const listed = await listSlackChannels({ env, connection })
    expect(listed.items).toHaveLength(2000)
    expect(listed.truncated).toBe(true)
  })
})
