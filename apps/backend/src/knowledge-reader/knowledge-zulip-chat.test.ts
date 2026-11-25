import { describe, expect, it } from "vitest"

import {
  readZulipChat,
  renderZulipChat,
  type ZulipAccess,
  type ZulipChat,
} from "../../evals/knowledge/zulip-chat.js"
import { useMswServer } from "../../test/msw.js"
import { serveZulip, zulipMessage as message } from "../../test/zulip.js"

/*
 * The chat export of an org twin (CTX-1661) against a small Zulip server in
 * msw (`test/zulip.ts`).
 */

const REALM = "https://chat.example.test"
const server = useMswServer()

const until = new Date("2026-11-01T00:00:00Z")
const seconds = (iso: string) => Date.parse(iso) / 1_000

const access: ZulipAccess = {
  fetch: (url) => fetch(url),
  pause: async () => {},
}

const chat: ZulipChat = {
  realm: REALM,
  since: "2026-10-01T00:00:00Z",
  channels: [7],
}

const quiet = () => {}

describe("the Zulip chat of an org twin", () => {
  it("reads the slice of each channel, and nothing after the cut-off date", async () => {
    serveZulip(server, REALM, [
      message(5, "2026-09-20T00:00:00Z"),
      message(8, "2026-10-02T00:00:00Z"),
      message(9, "2026-10-02T01:00:00Z", { stream_id: 3 }),
      ...Array.from({ length: 150 }, (_, index) =>
        message(100 + index, "2026-10-10T00:00:00Z"),
      ),
      message(400, "2026-10-31T23:59:59Z"),
      message(401, "2026-11-02T00:00:00Z"),
      message(402, "2026-11-20T00:00:00Z"),
    ])

    const read = await readZulipChat(chat, until, access, quiet)

    expect(read.map((item) => item.id)).toEqual([
      8,
      ...Array.from({ length: 150 }, (_, index) => 100 + index),
      400,
    ])
  })

  it("asks only for web-public messages, 100 at a time", async () => {
    const requests = serveZulip(server, REALM, [
      message(8, "2026-10-02T00:00:00Z"),
    ])

    await readZulipChat(chat, until, access, quiet)

    expect(requests.length).toBeGreaterThan(0)
    for (const url of requests) {
      expect(url.searchParams.get("narrow")).toContain('"web-public"')
      expect(
        Number(url.searchParams.get("num_before")) +
          Number(url.searchParams.get("num_after")),
      ).toBeLessThanOrEqual(100)
    }
  })

  it("writes one file for each topic, with pseudonyms and no names or emails", () => {
    const messages = [
      message(1, "2026-10-02T00:00:00Z", {
        content: "Ping @**Bo Reed|22** and @_**Ada Quill|11** about it.",
      }),
      message(2, "2026-10-02T01:00:00Z", {
        sender_id: 22,
        sender_full_name: "Bo Reed",
        content:
          "Ada Quill said so. Mail bo@reed.example, see #narrow/dm/11-Ada-Quill and @**Cy Unknown**.",
      }),
      message(3, "2026-10-03T00:00:00Z", {
        subject: "Another topic",
        content: "New topic.",
      }),
    ]

    const { files, manifest } = renderZulipChat(chat, until, messages)

    expect(files.map((file) => file.path)).toEqual([
      "chat/zulip/7-api-design/1.md",
      "chat/zulip/7-api-design/3.md",
    ])
    const text = files[0]?.content ?? ""
    expect(text).toContain("# Typing events")
    expect(text).toContain(
      "### person-0001 · 2026-10-02T00:00:00Z\n\nPing @person-0002 and @person-0001 about it.",
    )
    expect(text).toContain(
      "### person-0002 · 2026-10-02T01:00:00Z\n\nperson-0001 said so. Mail [email], see #narrow/[person] and @someone.",
    )
    expect(text).toContain("channelId: 7")
    expect(text).toContain("messages: 2")
    const everything = JSON.stringify({ files, manifest })
    for (const secret of ["Ada", "Quill", "Bo Reed", "reed.example", "Cy"])
      expect(everything).not.toContain(secret)
    expect(manifest).toMatchObject({
      topics: 2,
      messages: 3,
      people: 2,
      restoredFromHistory: 0,
      leftOut: 0,
      channels: [{ id: 7, name: "api design", topics: 2, messages: 3 }],
    })
    expect(manifest.files[0]).toMatchObject({
      path: "chat/zulip/7-api-design/1.md",
      firstMessageId: 1,
      messages: 2,
    })
    expect(manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    // The same slice gives the same files.
    expect(renderZulipChat(chat, until, messages).manifest).toEqual(manifest)
  })

  it("sets each message back to its text and topic at the cut-off date", () => {
    const after = seconds("2026-11-05T00:00:00Z")
    const before = seconds("2026-10-20T00:00:00Z")
    const messages = [
      // Edited before and after the cut-off date. The first later edit
      // holds the text at the cut-off date.
      message(1, "2026-10-02T00:00:00Z", {
        subject: "✔ Typing events",
        content: "Final text, with the later answer.",
        last_edit_timestamp: after + 10,
        last_moved_timestamp: after,
        edit_history: [
          { timestamp: after + 10, prev_content: "Second text." },
          { timestamp: after, prev_topic: "Typing events" },
          { timestamp: before, prev_content: "First text." },
        ],
      }),
      // Edited and resolved after the cut-off date, with no history: the
      // text is left out, and the resolved mark goes.
      message(2, "2026-10-02T01:00:00Z", {
        subject: "✔ Typing events",
        content: "Changed later.",
        last_edit_timestamp: after,
        last_moved_timestamp: after,
      }),
    ]

    const { files, manifest } = renderZulipChat(chat, until, messages)

    expect(files).toHaveLength(1)
    const text = files[0]?.content ?? ""
    expect(text).toContain("# Typing events")
    expect(text).toContain("resolved: false")
    expect(text).toContain("Second text.")
    expect(text).not.toContain("Final text")
    expect(text).toContain("Its text is left out.")
    expect(text).not.toContain("Changed later.")
    expect(manifest).toMatchObject({ restoredFromHistory: 1, leftOut: 1 })
  })
})
