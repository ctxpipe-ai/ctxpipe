import { describe, expect, it } from "vitest"
import {
  getSlackThreadPath,
  slackMrkdwnToMarkdown,
  toSlackThreadMarkdownFile,
} from "./converter.js"

describe("slack converter", () => {
  it("builds stable thread paths", () => {
    expect(
      getSlackThreadPath({
        channelId: "C123",
        channelName: "Engineering",
        threadTs: "1710000000.000100",
      }),
    ).toBe(
      "slack/channels/engineering--C123/threads/2024/03/1710000000.000100/index.md",
    )
  })

  it("converts common mrkdwn", () => {
    expect(slackMrkdwnToMarkdown("see <https://example.com|docs>")).toBe(
      "see [docs](https://example.com)",
    )
  })

  it("writes thread markdown with frontmatter", () => {
    const file = toSlackThreadMarkdownFile({
      channelId: "C1",
      channelName: "eng",
      isPrivate: false,
      threadTs: "1710000000.000100",
      messages: [
        {
          ts: "1710000000.000100",
          userId: "U1",
          userDisplay: "Ada",
          text: "hello",
        },
      ],
    })
    expect(file.content).toContain("source: slack")
    expect(file.content).toContain("thread_ts:")
    expect(file.content).toContain("### Ada")
    expect(file.content).toContain("hello")
  })

  it("notes when a long thread was truncated", () => {
    const file = toSlackThreadMarkdownFile({
      channelId: "C1",
      channelName: "eng",
      isPrivate: false,
      threadTs: "1710000000.000100",
      truncated: true,
      messages: [
        {
          ts: "1710000000.000100",
          userId: "U1",
          userDisplay: "Ada",
          text: "hello",
        },
      ],
    })
    expect(file.content).toContain("truncated: true")
    expect(file.content).toContain("later replies were omitted")
  })
})
