import { describe, expect, it } from "vitest"
import { gitBlobSha } from "../connectors/assets.js"
import {
  collectSlackMessageMedia,
  getSlackChannelIndexPath,
  getSlackThreadPath,
  resolveSlackChannelPathSlug,
  slackMrkdwnToMarkdown,
  toSlackChannelIndexFile,
  toSlackThreadMarkdownFile,
} from "./converter.js"

describe("slack converter", () => {
  it("builds a thread.md leaf while the channel index stays index.md", () => {
    expect(
      getSlackChannelIndexPath({
        channelId: "C123",
        channelName: "Engineering",
      }),
    ).toBe("slack/channels/engineering--C123/index.md")
    expect(
      getSlackThreadPath({
        channelId: "C123",
        channelName: "Engineering",
        threadTs: "1710000000.000100",
      }),
    ).toBe(
      "slack/channels/engineering--C123/threads/2024/03/1710000000.000100/thread.md",
    )
  })

  it("converts common mrkdwn", () => {
    expect(slackMrkdwnToMarkdown("see <https://example.com|docs>")).toBe(
      "see [docs](https://example.com)",
    )
  })

  it("resolves inline mentions to @handle when a profile map is provided", () => {
    const handles = new Map([
      ["U1", "ada"],
      ["U2", "bob"],
    ])
    expect(slackMrkdwnToMarkdown("hey <@U1> and <@U2|bobby>", handles)).toBe(
      "hey @ada and @bob",
    )
    expect(slackMrkdwnToMarkdown("hey <@U9>")).toBe("hey @unknown-user")
    expect(slackMrkdwnToMarkdown("hey <@U9|ghost>", handles)).toBe(
      "hey @unknown-user",
    )
  })

  it("reuses a path slug without changing the rendered channel name", () => {
    expect(
      getSlackChannelIndexPath({
        channelId: "C123",
        channelName: "Platform",
        pathSlug: "engineering",
      }),
    ).toBe("slack/channels/engineering--C123/index.md")
    expect(
      getSlackThreadPath({
        channelId: "C123",
        channelName: "Platform",
        pathSlug: "engineering",
        threadTs: "1710000000.000100",
      }),
    ).toBe(
      "slack/channels/engineering--C123/threads/2024/03/1710000000.000100/thread.md",
    )
    const channel = toSlackChannelIndexFile({
      channelId: "C123",
      channelName: "Platform",
      pathSlug: "engineering",
      isPrivate: false,
    })
    expect(channel.path).toBe("slack/channels/engineering--C123/index.md")
    expect(channel.content).toContain('channel_name: "Platform"')
    expect(channel.content).toContain("# #Platform")
    const thread = toSlackThreadMarkdownFile({
      channelId: "C123",
      channelName: "Platform",
      pathSlug: "engineering",
      isPrivate: false,
      threadTs: "1710000000.000100",
      messages: [
        {
          ts: "1710000000.000100",
          userId: "U9",
          text: "ping <@U9>",
        },
      ],
    })
    expect(thread.path).toBe(
      "slack/channels/engineering--C123/threads/2024/03/1710000000.000100/thread.md",
    )
    expect(thread.content).toContain('channel_name: "Platform"')
    expect(thread.content).toContain("# Thread in #Platform")
    expect(thread.content).toContain('participant_ids: ["U9"]')
    expect(thread.content).toContain("### unknown")
    expect(thread.content).toContain("ping @unknown-user")
    expect(thread.content).not.toMatch(/@U9\b/)
  })

  it("picks a stable existing channel path slug from the git tree", () => {
    expect(
      resolveSlackChannelPathSlug({
        existingPaths: [
          "slack/channels/platform--C123/index.md",
          "slack/channels/engineering--C123/threads/2024/03/1710000000.000100/thread.md",
          "slack/channels/other--C999/index.md",
        ],
        channelId: "C123",
        threadTs: "1710000000.000100",
        channelName: "Platform",
      }),
    ).toBe("engineering")
    expect(
      resolveSlackChannelPathSlug({
        existingPaths: ["slack/channels/eng--C1/index.md"],
        channelId: "C1",
        threadTs: "1710000000.000100",
        channelName: "Platform",
      }),
    ).toBe("eng")
    expect(
      resolveSlackChannelPathSlug({
        existingPaths: ["slack/channels/other--C999/index.md"],
        channelId: "C1",
        threadTs: "1710000000.000100",
        channelName: "Platform",
      }),
    ).toBe("platform")
  })

  it("writes thread markdown with identity frontmatter", () => {
    const file = toSlackThreadMarkdownFile({
      channelId: "C1",
      channelName: "eng",
      isPrivate: false,
      threadTs: "1710000000.000100",
      permalink: "https://acme.slack.com/archives/C1/p1710000000000100",
      capturedAt: "2026-08-19T04:00:00.000Z",
      capturedBy: { handle: "ada", name: "Ada Lovelace" },
      messages: [
        {
          ts: "1710000000.000100",
          userId: "U1",
          userDisplay: "Ada",
          text: "hello",
        },
      ],
    })
    expect(file.path).toBe(
      "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
    )
    expect(file.content).toContain("source: slack")
    expect(file.content).toContain("thread_ts:")
    expect(file.content).toContain("permalink:")
    expect(file.content).toContain("captured_at:")
    expect(file.content).toContain('handle: "ada"')
    expect(file.content).toContain('name: "Ada Lovelace"')
    expect(file.content).toContain("### Ada")
    expect(file.content).toContain("hello")
  })

  it("renders downloaded images and files as relative markdown", () => {
    const file = toSlackThreadMarkdownFile({
      channelId: "C1",
      channelName: "eng",
      isPrivate: false,
      threadTs: "1710000000.000100",
      mentionHandles: new Map([["U2", "bob"]]),
      messages: [
        {
          ts: "1710000000.000100",
          userId: "U1",
          userDisplay: "Ada",
          text: "see <@U2>",
          assetLinks: [
            {
              label: "diagram.png",
              path: "assets/F1--diagram.png",
              kind: "image",
            },
            {
              label: "notes.pdf",
              path: "assets/F2--notes.pdf",
              kind: "file",
            },
            {
              label: "missing.png",
              path: "https://acme.slack.com/files/U1/F3/missing.png",
              kind: "file",
            },
            {
              label: "unavailable.pdf",
              path: "",
              kind: "file",
            },
          ],
        },
      ],
    })
    expect(file.content).toContain("see @bob")
    expect(file.content).toContain("![diagram.png](assets/F1--diagram.png)")
    expect(file.content).toContain("[notes.pdf](assets/F2--notes.pdf)")
    expect(file.content).toContain(
      "[missing.png](https://acme.slack.com/files/U1/F3/missing.png)",
    )
    expect(file.content).toContain("[file: unavailable.pdf unavailable]")
    expect(file.content).not.toContain("url_private")
  })

  it("omits captured_by when lookup failed", () => {
    const file = toSlackThreadMarkdownFile({
      channelId: "C1",
      channelName: "eng",
      isPrivate: false,
      threadTs: "1710000000.000100",
      capturedAt: "2026-08-19T04:00:00.000Z",
      messages: [
        {
          ts: "1710000000.000100",
          text: "hello",
        },
      ],
    })
    expect(file.content).not.toContain("captured_by")
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

describe("collectSlackMessageMedia", () => {
  it("collects message.files plus explicit block and legacy attachment media", () => {
    const external = "https://cdn.example.com/hero.png"
    const media = collectSlackMessageMedia({
      files: [
        {
          id: "F1",
          name: "diagram.png",
          mimetype: "image/png",
          permalink: "https://acme.slack.com/files/U1/F1/diagram.png",
          url_private: "https://files.slack.com/files-pri/T1-F1/diagram.png",
          url_private_download:
            "https://files.slack.com/files-pri/T1-F1/download/diagram.png",
        },
      ],
      blocks: [
        {
          type: "image",
          alt_text: "hero",
          image_url: external,
        },
        {
          type: "image",
          slack_file: {
            id: "F9",
            url: "https://files.slack.com/files-pri/T1-F9/block.png",
          },
          alt_text: "block.png",
        },
        {
          type: "section",
          accessory: {
            type: "image",
            image_url: "https://cdn.example.com/badge.png",
            alt_text: "badge.png",
          },
        },
      ],
      attachments: [
        {
          image_url: "https://cdn.example.com/attach.jpg",
          title: "attach.jpg",
        },
        {
          files: [
            {
              id: "F8",
              name: "legacy.pdf",
              permalink: "https://acme.slack.com/files/U1/F8/legacy.pdf",
              url_private: "https://files.slack.com/files-pri/T1-F8/legacy.pdf",
            },
          ],
        },
      ],
    })

    expect(media).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKey: "F1",
          filename: "diagram.png",
          downloadUrl:
            "https://files.slack.com/files-pri/T1-F1/download/diagram.png",
          permalink: "https://acme.slack.com/files/U1/F1/diagram.png",
        }),
        expect.objectContaining({
          sourceKey: "F9",
          downloadUrl: "https://files.slack.com/files-pri/T1-F9/block.png",
        }),
        expect.objectContaining({
          sourceKey: "F8",
          filename: "legacy.pdf",
        }),
        expect.objectContaining({
          filename: "hero.png",
          downloadUrl: external,
        }),
        expect.objectContaining({
          filename: "badge.png",
          downloadUrl: "https://cdn.example.com/badge.png",
        }),
        expect.objectContaining({
          filename: "attach.jpg",
          downloadUrl: "https://cdn.example.com/attach.jpg",
        }),
      ]),
    )
    expect(media.map((item) => item.sourceKey)).toContain(
      `src-${gitBlobSha(Buffer.from(external)).slice(0, 12)}`,
    )
    expect(JSON.stringify(media)).not.toContain("url_private")
  })

  it("does not treat mrkdwn URLs as media", () => {
    expect(
      collectSlackMessageMedia({
        text: "see <https://cdn.example.com/not-an-attachment.png>",
      }),
    ).toEqual([])
  })
})
