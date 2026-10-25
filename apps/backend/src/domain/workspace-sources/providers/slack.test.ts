import { describe, expect, it } from "vitest"

import { parseSourceEntry } from "../sources-file.js"
import { slackSourceScope, summarizeSlackScope } from "./slack.js"

describe("Slack source scope", () => {
  it("accepts channel ids from a sources.yaml entry", () => {
    expect(
      parseSourceEntry({
        id: "eng-threads",
        provider: "slack",
        connection: "con_slack1",
        channels: ["C0123ABCD", "G0456EFGH"],
      }),
    ).toEqual({
      ok: true,
      entry: {
        key: "eng-threads",
        provider: "slack",
        connectionId: "con_slack1",
        scope: { channels: ["C0123ABCD", "G0456EFGH"] },
      },
    })
  })

  it("refuses an empty scope", () => {
    expect(slackSourceScope.schema.safeParse({}).success).toBe(false)
    expect(slackSourceScope.schema.safeParse({ channels: [] }).success).toBe(
      false,
    )
  })

  it("refuses a value that is not a Slack channel id", () => {
    for (const bad of [
      ["#general"],
      ["general"],
      ["C0123/../x"],
      ["D0123ABCD"],
      [""],
    ])
      expect(slackSourceScope.schema.safeParse({ channels: bad }).success).toBe(
        false,
      )
  })

  it("refuses the same channel twice", () => {
    expect(
      slackSourceScope.schema.safeParse({
        channels: ["C0123ABCD", "C0123ABCD"],
      }).success,
    ).toBe(false)
  })

  it("summarizes the channel count", () => {
    expect(summarizeSlackScope({ channels: ["C0123ABCD"] })).toBe(
      "1 Slack channel",
    )
    expect(summarizeSlackScope({ channels: ["C0123ABCD", "C0456EFGH"] })).toBe(
      "2 Slack channels",
    )
  })
})
