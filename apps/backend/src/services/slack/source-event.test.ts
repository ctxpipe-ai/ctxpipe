import { describe, expect, it } from "vitest"
import {
  slackEventMatches,
  slackSourceEventFromMessage,
} from "./source-event.js"

const bot = "U0BOT0001"

describe("slackSourceEventFromMessage", () => {
  it("reads the thread of a reply, an edit, and a delete", () => {
    expect(
      slackSourceEventFromMessage(
        {
          type: "message",
          channel: "C0ENG0001",
          channel_type: "channel",
          user: "U0PERSON1",
          ts: "1790000100.000200",
          thread_ts: "1790000000.000100",
        },
        bot,
      ),
    ).toEqual({ channelId: "C0ENG0001", threadTs: "1790000000.000100" })
    expect(
      slackSourceEventFromMessage(
        {
          type: "message",
          subtype: "message_changed",
          channel: "G0PRIV001",
          channel_type: "group",
          message: { thread_ts: "1790000000.000100", user: "U0PERSON1" },
        },
        bot,
      ),
    ).toEqual({ channelId: "G0PRIV001", threadTs: "1790000000.000100" })
    expect(
      slackSourceEventFromMessage(
        {
          type: "message",
          subtype: "message_deleted",
          channel: "C0ENG0001",
          channel_type: "channel",
          previous_message: { thread_ts: "1790000000.000100" },
        },
        bot,
      ),
    ).toEqual({ channelId: "C0ENG0001", threadTs: "1790000000.000100" })
  })

  it("ignores a message without a thread, a direct message, and the own bot", () => {
    const base = {
      type: "message",
      channel: "C0ENG0001",
      channel_type: "channel",
      user: "U0PERSON1",
      ts: "1790000000.000100",
    }
    expect(slackSourceEventFromMessage(base, bot)).toBeNull()
    expect(
      slackSourceEventFromMessage(
        { ...base, channel_type: "im", thread_ts: "1790000000.000100" },
        bot,
      ),
    ).toBeNull()
    expect(
      slackSourceEventFromMessage(
        { ...base, user: bot, thread_ts: "1790000000.000100" },
        bot,
      ),
    ).toBeNull()
  })
})

describe("slackEventMatches", () => {
  it("matches a scope only by its channel ids", () => {
    const event = { channelId: "C0ENG0001", threadTs: "1790000000.000100" }
    expect(slackEventMatches(event, { channels: ["C0ENG0001"] })).toBe(true)
    expect(slackEventMatches(event, { channels: ["C0OPS0001"] })).toBe(false)
  })
})
