import { describe, expect, it } from "vitest"

import {
  readZulipChat,
  renderZulipChat,
  type ZulipChat,
} from "../../evals/knowledge/zulip-chat.js"
import { useMswServer } from "../../test/msw.js"
import {
  serveZulip,
  withFakeClock,
  zulipMessage as message,
} from "../../test/zulip.js"

/*
 * The chat export of an org twin (CTX-1661) against a small Zulip server in
 * msw (`test/zulip.ts`), with a fake clock for the wait before each request.
 */

const REALM = "https://chat.example.test"
const server = useMswServer()

const until = new Date("2026-11-01T00:00:00Z")
const seconds = (iso: string) => Date.parse(iso) / 1_000

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

    const read = await withFakeClock(() => readZulipChat(chat, until, quiet))

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

    await withFakeClock(() => readZulipChat(chat, until, quiet))

    expect(requests.length).toBeGreaterThan(0)
    for (const url of requests) {
      expect(url.searchParams.get("narrow")).toContain('"web-public"')
      expect(
        Number(url.searchParams.get("num_before")) +
          Number(url.searchParams.get("num_after")),
      ).toBeLessThanOrEqual(100)
    }
  })

  it("refuses a page that is not a list of messages", async () => {
    serveZulip(server, REALM, [
      { ...message(8, "2026-10-02T00:00:00Z"), stream_id: "../../x" as never },
    ])

    await expect(
      withFakeClock(() => readZulipChat(chat, until, quiet)),
    ).rejects.toThrow()
  })

  it("writes one file for each topic, with pseudonyms and no names, ids or emails", () => {
    const messages = [
      message(1, "2026-10-02T00:00:00Z", {
        content: "Ping @**Bo Reed|22** and @_**Ada Quill|11** about it.",
      }),
      message(2, "2026-10-02T01:00:00Z", {
        sender_id: 22,
        sender_full_name: "Bo Reed",
        content: [
          "ada quill said so, and Ada agreed.",
          "Mail bo@reed.example.",
          "See #narrow/dm/11-Ada-Quill and #narrow/channel/7-api-design/sender/11.",
          "Ask @**Cy Unknown**. ![](https://secure.gravatar.com/avatar/0a1b2c?d=identicon)",
        ].join(" "),
      }),
      // Zulip topic names do not depend on case.
      message(3, "2026-10-03T00:00:00Z", { subject: "typing EVENTS" }),
      message(4, "2026-10-03T00:00:00Z", {
        subject: "Another topic",
        content: "New topic.",
      }),
    ]

    const { files, manifest } = renderZulipChat(chat, until, messages)

    expect(files.map((file) => file.path)).toEqual([
      "chat/zulip/7/1.md",
      "chat/zulip/7/4.md",
    ])
    const text = files[0]?.content ?? ""
    expect(text).toContain("# Typing events")
    expect(text).toContain(
      "### person-0001 · 2026-10-02T00:00:00Z\n\nPing @person-0002 and @person-0001 about it.",
    )
    expect(text).toContain(
      "person-0001 said so, and person-0001 agreed. Mail [email]. See #narrow/dm/[person] and #narrow/channel/7-api-design/sender/[person]. Ask @someone. ![]([avatar])",
    )
    expect(text).toContain("channelId: 7")
    expect(text).toContain("messages: 3")
    const everything = JSON.stringify({ files, manifest })
    for (const secret of [
      "Ada",
      "ada",
      "Quill",
      "Bo Reed",
      "reed.example",
      "Cy",
      "sender/11",
      "0a1b2c",
    ])
      expect(everything).not.toContain(secret)
    expect(manifest).toMatchObject({
      topics: 2,
      messages: 4,
      people: 2,
      restoredFromHistory: 0,
      leftOut: 0,
      moveNotRestored: 0,
      outOfSlice: 0,
      channels: [{ id: 7, topics: 2, messages: 4 }],
    })
    expect(manifest.files[0]).toMatchObject({
      path: "chat/zulip/7/1.md",
      firstMessageId: 1,
      messages: 3,
    })
    expect(manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    // The same slice gives the same files.
    expect(renderZulipChat(chat, until, messages).manifest).toEqual(manifest)
  })

  it("sets each message back to its text, topic and channel at the cut-off date", () => {
    const after = seconds("2026-11-05T00:00:00Z")
    const before = seconds("2026-10-20T00:00:00Z")
    const messages = [
      // Edited before and after the cut-off date, and resolved after it.
      // The first later edit holds the text at the cut-off date.
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
      // Edited and resolved after the cut-off date, and the history does
      // not explain it: the text is left out, and the resolved mark goes.
      message(2, "2026-10-02T01:00:00Z", {
        subject: "✔ Typing events",
        content: "Changed later.",
        last_edit_timestamp: after,
        last_moved_timestamp: after,
        edit_history: [],
      }),
      // Moved here from channel 7 after the cut-off date.
      message(3, "2026-10-02T02:00:00Z", {
        stream_id: 9,
        display_recipient: "archive",
        last_moved_timestamp: after,
        edit_history: [{ timestamp: after, prev_stream: 7 }],
      }),
      // Moved to channel 7 from a channel out of the slice.
      message(4, "2026-10-02T03:00:00Z", {
        last_moved_timestamp: after,
        edit_history: [{ timestamp: after, prev_stream: 12 }],
      }),
    ]

    const { files, manifest } = renderZulipChat(chat, until, messages)

    expect(files.map((file) => file.path)).toEqual(["chat/zulip/7/1.md"])
    const text = files[0]?.content ?? ""
    expect(text).toContain("# Typing events")
    expect(text).toContain("resolved: false")
    expect(text).toContain("Second text.")
    expect(text).not.toContain("Final text")
    expect(text).toContain("Its text is left out.")
    expect(text).not.toContain("Changed later.")
    expect(text).toContain("messages: 3")
    expect(manifest).toMatchObject({
      messages: 3,
      restoredFromHistory: 2,
      leftOut: 1,
      moveNotRestored: 1,
      outOfSlice: 1,
    })
  })
})
