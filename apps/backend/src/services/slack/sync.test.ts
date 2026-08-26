import { beforeEach, describe, expect, it, vi } from "vitest"

const limitMock = vi.hoisted(() => vi.fn())
const whereMock = vi.hoisted(() => vi.fn(() => ({ limit: limitMock })))
const fromMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })))
const selectMock = vi.hoisted(() => vi.fn(() => ({ from: fromMock })))
const getOrgDbMock = vi.hoisted(() => vi.fn(() => ({ select: selectMock })))
const listRepliesMock = vi.hoisted(() => vi.fn())
const commitFilesMock = vi.hoisted(() => vi.fn())
const listFilesInTreeMock = vi.hoisted(() => vi.fn())
const downloadAssetMock = vi.hoisted(() => vi.fn())
const botTokenMock = vi.hoisted(() => vi.fn(() => "xoxb-test"))

vi.mock("../../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../github/installation-write-client.js", () => ({
  commitFiles: commitFilesMock,
  listFilesInTree: listFilesInTreeMock,
}))
vi.mock("../connectors/assets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../connectors/assets.js")>()),
  downloadConnectorAsset: downloadAssetMock,
}))
const resolveChannelInfoMock = vi.hoisted(() =>
  vi.fn(async ({ channelId }: { channelId: string }) => ({
    channelId,
    name: "eng",
    isPrivate: false,
  })),
)
const getPermalinkMock = vi.hoisted(() =>
  vi.fn(async () => "https://acme.slack.com/archives/C1/p1710000000000100"),
)
const resolveProfileMock = vi.hoisted(() => vi.fn())
const fetchFileInfoMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  listSlackConversationReplies: listRepliesMock,
  resolveSlackChannelInfo: resolveChannelInfoMock,
  resolveSlackUserProfile: resolveProfileMock,
  fetchSlackFileInfo: fetchFileInfoMock,
  getSlackPermalink: getPermalinkMock,
  botTokenFromConnection: botTokenMock,
}))

import { gitBlobSha } from "../connectors/assets.js"
import { SlackDirectMessageNotSupportedError } from "./client.js"
import { captureSlackThread } from "./sync.js"

const target = {
  id: "con_1",
  orgId: "org_1",
  connectionId: "con_1",
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
}

const connection = {
  id: "con_1",
  orgId: "org_1",
  teamId: "T1",
  teamName: "Acme",
  botTokenEnc: "enc",
  botUserId: "U_BOT",
  botHandle: "ctxpipe",
  appId: null,
  ownerUserId: null,
  status: "installed",
  lastEventPayload: null,
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
}

function committedFiles() {
  return commitFilesMock.mock.calls[0]?.[0]?.files as Array<{
    path: string
    content: string
    encoding?: string
  }>
}

function threadMarkdown() {
  return committedFiles().find((file) => file.path.endsWith("/thread.md"))
}

describe("captureSlackThread", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchFileInfoMock.mockReset()
    fetchFileInfoMock.mockResolvedValue(undefined)
    resolveChannelInfoMock.mockResolvedValue({
      channelId: "C1",
      name: "eng",
      isPrivate: false,
    })
    getPermalinkMock.mockResolvedValue(
      "https://acme.slack.com/archives/C1/p1710000000000100",
    )
    resolveProfileMock.mockImplementation(
      async ({
        userId,
        cache,
      }: {
        userId: string
        cache: Map<string, { handle: string; name: string }>
      }) => {
        const cached = cache.get(userId)
        if (cached) return cached
        const profile =
          userId === "U2"
            ? { handle: "bob", name: "Bob" }
            : { handle: "ada", name: "Ada Lovelace" }
        cache.set(userId, profile)
        return profile
      },
    )
    botTokenMock.mockReturnValue("xoxb-test")
    listFilesInTreeMock.mockResolvedValue([])
    downloadAssetMock.mockResolvedValue({
      status: "stub",
      reason: "download_failed",
    })
    limitMock.mockResolvedValue([
      { name: "acme/context", githubConnectionId: "ghc_1" },
    ])
    commitFilesMock.mockResolvedValue({ commitSha: "sha123" })
  })

  it("commits the channel index and thread markdown for a captured thread", async () => {
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "hello world",
        },
      ],
    })

    const result = await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(result).toMatchObject({
      status: "completed",
      messageCount: 1,
      channelName: "eng",
      threadPath: expect.stringContaining(
        "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
      ),
      githubUrl: expect.stringMatching(
        /^https:\/\/github\.com\/acme\/context\/blob\/sha123\/slack\//,
      ),
    })
    expect(commitFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryName: "acme/context",
        githubConnectionId: "ghc_1",
        branch: "main",
        message: expect.stringContaining("#eng"),
        files: expect.arrayContaining([
          expect.objectContaining({
            path: "slack/channels/eng--C1/index.md",
          }),
          expect.objectContaining({
            path: "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
          }),
        ]),
      }),
    )
    expect(
      committedFiles().filter((file) => file.path.endsWith("/index.md")),
    ).toEqual([
      expect.objectContaining({ path: "slack/channels/eng--C1/index.md" }),
    ])
  })

  it("omits the in-thread status message from the snapshot", async () => {
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        { ts: "1710000000.000100", user: "U1", text: "decision" },
        {
          ts: "1710000000.000200",
          user: "U_BOT",
          text: "ctx| agent capturing engineering context…",
        },
      ],
    })

    await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
      excludeMessageTs: "1710000000.000200",
    })

    expect(threadMarkdown()?.content).toContain("decision")
    expect(threadMarkdown()?.content).not.toContain(
      "capturing engineering context",
    )
  })

  it("writes captured_by handle+name, permalink, and captured_at", async () => {
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [{ ts: "1710000000.000100", user: "U1", text: "decision" }],
    })

    await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
      capturedByUserId: "U1",
    })

    expect(threadMarkdown()?.path).toContain(
      "/threads/2024/03/1710000000.000100/thread.md",
    )
    expect(threadMarkdown()?.content).toContain('handle: "ada"')
    expect(threadMarkdown()?.content).toContain('name: "Ada Lovelace"')
    expect(threadMarkdown()?.content).toContain(
      'permalink: "https://acme.slack.com/archives/C1/p1710000000000100"',
    )
    expect(threadMarkdown()?.content).toMatch(/captured_at: "/)
  })

  it("resolves authors and inline mentions through one shared profile cache", async () => {
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "hey <@U2> from <@U1>",
        },
      ],
    })

    await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    const cache = resolveProfileMock.mock.calls[0]?.[0]?.cache
    expect(cache).toBeInstanceOf(Map)
    expect(
      resolveProfileMock.mock.calls.every((call) => call[0]?.cache === cache),
    ).toBe(true)
    expect(threadMarkdown()?.content).toContain("### Ada Lovelace (@ada)")
    expect(threadMarkdown()?.content).toContain("hey @bob from @ada")
  })

  it("renders a neutral mention fallback when a profile lookup fails", async () => {
    resolveProfileMock.mockImplementation(
      async ({
        userId,
        cache,
      }: {
        userId: string
        cache: Map<string, { handle: string; name: string }>
      }) => {
        if (userId === "U9") return undefined
        const cached = cache.get(userId)
        if (cached) return cached
        const profile = { handle: "ada", name: "Ada Lovelace" }
        cache.set(userId, profile)
        return profile
      },
    )
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "hey <@U9>",
        },
      ],
    })

    await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(threadMarkdown()?.content).toContain("hey @unknown-user")
    expect(threadMarkdown()?.content).toContain("### Ada Lovelace (@ada)")
    expect(threadMarkdown()?.content).toContain('participant_ids: ["U1"]')
    expect(threadMarkdown()?.content).not.toMatch(/@U9\b/)
  })

  it("recaptures into the existing channel root after a rename", async () => {
    resolveChannelInfoMock.mockResolvedValue({
      channelId: "C1",
      name: "platform",
      isPrivate: false,
    })
    listFilesInTreeMock.mockResolvedValue([
      { path: "slack/channels/platform--C1/index.md", sha: "new-name" },
      { path: "slack/channels/eng--C1/index.md", sha: "channel" },
      {
        path: "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
        sha: "old-thread",
      },
      {
        path: "slack/channels/eng--C1/threads/2024/03/1710000000.000100/index.md",
        sha: "legacy",
      },
      {
        path: "slack/channels/eng--C1/threads/2024/03/1710000000.000100/assets/F-OLD--gone.png",
        sha: "stale",
      },
    ])
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "still here",
        },
      ],
    })

    const result = await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(result.threadPath).toBe(
      "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
    )
    expect(threadMarkdown()?.path).toBe(
      "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
    )
    expect(threadMarkdown()?.content).toContain('channel_name: "platform"')
    expect(threadMarkdown()?.content).toContain("# Thread in #platform")
    expect(committedFiles().map((file) => file.path)).toEqual([
      "slack/channels/eng--C1/index.md",
      "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
    ])
    expect(
      committedFiles().some((file) => file.path.includes("platform--C1")),
    ).toBe(false)
    const channelIndex = committedFiles().find((file) =>
      file.path.endsWith("eng--C1/index.md"),
    )
    expect(channelIndex?.content).toContain('channel_name: "platform"')
    expect(channelIndex?.content).toContain("# #platform")
    expect(commitFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: expect.arrayContaining([
          "slack/channels/eng--C1/threads/2024/03/1710000000.000100/index.md",
          "slack/channels/eng--C1/threads/2024/03/1710000000.000100/assets/F-OLD--gone.png",
        ]),
      }),
    )
  })

  it("reuses any existing channel root when this thread is new", async () => {
    resolveChannelInfoMock.mockResolvedValue({
      channelId: "C1",
      name: "platform",
      isPrivate: false,
    })
    listFilesInTreeMock.mockResolvedValue([
      { path: "slack/channels/eng--C1/index.md", sha: "channel" },
    ])
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [{ ts: "1710000000.000100", user: "U1", text: "first" }],
    })

    const result = await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(result.threadPath).toBe(
      "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
    )
    expect(committedFiles().map((file) => file.path)).toEqual([
      "slack/channels/eng--C1/index.md",
      "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
    ])
  })

  it("downloads Slack files with a bot bearer only on Slack hosts and never persists url_private", async () => {
    const bytes = Buffer.from("png-bytes")
    downloadAssetMock.mockResolvedValue({
      status: "downloaded",
      bytes,
      filename: "secret.png",
      contentType: "image/png",
    })
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "file",
          files: [
            {
              id: "F1",
              name: "secret.png",
              mimetype: "image/png",
              permalink: "https://acme.slack.com/files/U1/F1/secret.png",
              url_private: "https://files.slack.com/files-pri/T1-F1/secret.png",
            },
          ],
        },
      ],
    })

    await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(downloadAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://files.slack.com/files-pri/T1-F1/secret.png",
        filename: "secret.png",
        headers: { Authorization: "Bearer xoxb-test" },
        authenticatedHosts: expect.arrayContaining(["files.slack.com"]),
        budget: expect.objectContaining({
          maxAssetBytes: 25 * 1024 * 1024,
          remainingBytes: 100 * 1024 * 1024,
        }),
      }),
    )
    const asset = committedFiles().find((file) =>
      file.path.endsWith("/assets/F1--secret.png"),
    )
    expect(asset).toMatchObject({
      encoding: "base64",
      content: bytes.toString("base64"),
    })
    expect(threadMarkdown()?.content).toContain(
      "![secret.png](assets/F1--secret.png)",
    )
    expect(JSON.stringify(committedFiles())).not.toContain("files.slack.com")
    expect(JSON.stringify(committedFiles())).not.toContain("url_private")
  })

  it("downloads explicit block and attachment media including external URLs without a Slack bearer", async () => {
    downloadAssetMock.mockImplementation(async ({ url }: { url: string }) => ({
      status: "downloaded",
      bytes: Buffer.from(url),
      filename: url.split("/").pop() ?? "attachment",
      contentType: "image/png",
    }))
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "media",
          blocks: [
            {
              type: "image",
              alt_text: "hero.png",
              image_url: "https://cdn.example.com/hero.png",
            },
          ],
          attachments: [{ image_url: "https://cdn.example.com/attach.jpg" }],
        },
      ],
    })

    await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(downloadAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.example.com/hero.png",
        headers: undefined,
        authenticatedHosts: [],
      }),
    )
    expect(downloadAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.example.com/attach.jpg",
        authenticatedHosts: [],
      }),
    )
    const heroCall = downloadAssetMock.mock.calls.find(
      (call) => call[0]?.url === "https://cdn.example.com/hero.png",
    )?.[0]
    expect(heroCall?.headers?.authorization).toBeUndefined()
    expect(
      committedFiles().some(
        (file) => file.path.includes("/assets/") && file.encoding === "base64",
      ),
    ).toBe(true)
    expect(threadMarkdown()?.content).toContain("](assets/")
  })

  it("resolves ID-only Block Kit files before capture", async () => {
    fetchFileInfoMock.mockResolvedValue({
      id: "F1",
      name: "block-image.png",
      mimetype: "image/png",
      permalink: "https://acme.slack.com/files/U1/F1/block-image.png",
      url_private: "https://files.slack.com/files-pri/T1-F1/block-image.png",
    })
    downloadAssetMock.mockResolvedValue({
      status: "downloaded",
      bytes: Buffer.from("block-image"),
      filename: "block-image.png",
      contentType: "image/png",
    })
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "block image",
          blocks: [
            {
              type: "image",
              alt_text: "Block image",
              slack_file: { id: "F1" },
            },
          ],
        },
      ],
    })

    await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(fetchFileInfoMock).toHaveBeenCalledWith({
      botToken: "xoxb-test",
      fileId: "F1",
      signal: expect.any(AbortSignal),
    })
    expect(downloadAssetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://files.slack.com/files-pri/T1-F1/block-image.png",
      }),
    )
    expect(
      committedFiles().some((file) =>
        file.path.endsWith("/assets/F1--block-image.png"),
      ),
    ).toBe(true)
    expect(threadMarkdown()?.content).toContain(
      "![block-image.png](assets/F1--block-image.png)",
    )
  })

  it("stubs failed or oversized downloads with a permalink and still completes capture", async () => {
    downloadAssetMock
      .mockResolvedValueOnce({ status: "stub", reason: "download_failed" })
      .mockResolvedValueOnce({ status: "stub", reason: "asset_limit" })
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "see diagram",
          files: [
            {
              id: "F1",
              name: "diagram.png",
              permalink: "https://acme.slack.com/files/U1/F1/diagram.png",
              url_private_download:
                "https://files.slack.com/files-pri/T1-F1/download/diagram.png",
            },
            {
              id: "F2",
              name: "huge.bin",
              permalink: "https://acme.slack.com/files/U1/F2/huge.bin",
              url_private: "https://files.slack.com/files-pri/T1-F2/huge.bin",
            },
            {
              id: "F3",
              name: "public-secret.png",
              permalink_public:
                "https://slack-files.com/T1-F3-secret/public-secret.png",
            },
          ],
        },
      ],
    })

    const result = await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(result.status).toBe("completed")
    expect(committedFiles().every((file) => file.encoding !== "base64")).toBe(
      true,
    )
    expect(
      committedFiles().some((file) => file.path.includes("/assets/")),
    ).toBe(false)
    expect(threadMarkdown()?.content).toContain(
      "[diagram.png](https://acme.slack.com/files/U1/F1/diagram.png)",
    )
    expect(threadMarkdown()?.content).toContain(
      "[huge.bin](https://acme.slack.com/files/U1/F2/huge.bin)",
    )
    expect(threadMarkdown()?.content).toContain(
      "[file: public-secret.png unavailable]",
    )
    expect(threadMarkdown()?.content).not.toContain("files.slack.com/files-pri")
    expect(threadMarkdown()?.content).not.toContain("slack-files.com")
  })

  it("on recapture deletes the old thread index.md and stale assets under that thread only", async () => {
    const bytes = Buffer.from("same-png")
    listFilesInTreeMock.mockResolvedValue([
      { path: "slack/channels/eng--C1/index.md", sha: "channel" },
      {
        path: "slack/channels/eng--C1/threads/2024/03/1710000000.000100/index.md",
        sha: "legacy",
      },
      {
        path: "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
        sha: "old-thread",
      },
      {
        path: "slack/channels/eng--C1/threads/2024/03/1710000000.000100/assets/F-OLD--gone.png",
        sha: "stale",
      },
      {
        path: "slack/channels/eng--C1/threads/2024/03/1710000000.000100/assets/F1--keep.png",
        sha: gitBlobSha(bytes),
      },
      {
        path: "slack/channels/eng--C1/threads/2024/03/1710000000.000200/assets/F-OTHER--keep.png",
        sha: "other",
      },
    ])
    downloadAssetMock.mockResolvedValue({
      status: "downloaded",
      bytes,
      filename: "keep.png",
      contentType: "image/png",
    })
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "file",
          files: [
            {
              id: "F1",
              name: "keep.png",
              url_private: "https://files.slack.com/files-pri/T1-F1/keep.png",
            },
          ],
        },
      ],
    })

    await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(commitFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deletePaths: expect.arrayContaining([
          "slack/channels/eng--C1/threads/2024/03/1710000000.000100/index.md",
          "slack/channels/eng--C1/threads/2024/03/1710000000.000100/assets/F-OLD--gone.png",
        ]),
      }),
    )
    const deletePaths = commitFilesMock.mock.calls[0]?.[0]
      ?.deletePaths as string[]
    expect(deletePaths).not.toContain("slack/channels/eng--C1/index.md")
    expect(deletePaths).not.toContain(
      "slack/channels/eng--C1/threads/2024/03/1710000000.000100/assets/F1--keep.png",
    )
    expect(deletePaths).not.toContain(
      "slack/channels/eng--C1/threads/2024/03/1710000000.000200/assets/F-OTHER--keep.png",
    )
    expect(
      committedFiles().some((file) =>
        file.path.endsWith("/assets/F1--keep.png"),
      ),
    ).toBe(false)
  })

  it("preserves a previously captured file when recapture download fails", async () => {
    const existingAsset =
      "slack/channels/eng--C1/threads/2024/03/1710000000.000100/assets/F1--keep.png"
    listFilesInTreeMock.mockResolvedValue([
      {
        path: "slack/channels/eng--C1/threads/2024/03/1710000000.000100/thread.md",
        sha: "old-thread",
      },
      { path: existingAsset, sha: "old-asset" },
    ])
    downloadAssetMock.mockResolvedValue({
      status: "stub",
      reason: "download_failed",
    })
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [
        {
          ts: "1710000000.000100",
          user: "U1",
          text: "file",
          files: [
            {
              id: "F1",
              name: "keep.png",
              permalink: "https://acme.slack.com/files/U1/F1/keep.png",
              url_private: "https://files.slack.com/files-pri/T1-F1/keep.png",
            },
          ],
        },
      ],
    })

    await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    const deletePaths = commitFilesMock.mock.calls[0]?.[0]
      ?.deletePaths as string[]
    expect(deletePaths).not.toContain(existingAsset)
    expect(threadMarkdown()?.content).toContain(
      "[keep.png](https://acme.slack.com/files/U1/F1/keep.png)",
    )
  })

  it("fails closed when the GitHub tree listing is truncated", async () => {
    listFilesInTreeMock.mockRejectedValue(
      new Error(
        "GitHub repository tree is truncated; refusing unsafe managed-file reconciliation",
      ),
    )
    listRepliesMock.mockResolvedValue({
      truncated: false,
      messages: [{ ts: "1710000000.000100", user: "U1", text: "hello" }],
    })

    const result = await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "capture_failed",
    })
    expect(commitFilesMock).not.toHaveBeenCalled()
  })

  it("fails capture for DMs instead of treating them as public channels", async () => {
    resolveChannelInfoMock.mockRejectedValue(
      new SlackDirectMessageNotSupportedError(),
    )

    const result = await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "D1",
      threadTs: "1710000000.000100",
    })

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "dm_not_supported",
    })
    expect(commitFilesMock).not.toHaveBeenCalled()
  })

  it("fails without committing when the thread has no messages", async () => {
    listRepliesMock.mockResolvedValue({ messages: [], truncated: false })

    const result = await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(result.status).toBe("failed")
    expect(commitFilesMock).not.toHaveBeenCalled()
  })

  it("returns failed when Slack API fetch throws", async () => {
    listRepliesMock.mockRejectedValue(new Error("ratelimited"))

    const result = await captureSlackThread({
      orgId: "org_1",
      env: {} as never,
      connection,
      target,
      channelId: "C1",
      threadTs: "1710000000.000100",
    })

    expect(result).toMatchObject({ status: "failed", error: "ratelimited" })
    expect(commitFilesMock).not.toHaveBeenCalled()
  })
})
