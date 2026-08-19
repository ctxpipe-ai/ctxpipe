import { beforeEach, describe, expect, it, vi } from "vitest"

const limitMock = vi.hoisted(() => vi.fn())
const whereMock = vi.hoisted(() => vi.fn(() => ({ limit: limitMock })))
const fromMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })))
const selectMock = vi.hoisted(() => vi.fn(() => ({ from: fromMock })))
const getOrgDbMock = vi.hoisted(() => vi.fn(() => ({ select: selectMock })))
const listRepliesMock = vi.hoisted(() => vi.fn())
const commitFilesMock = vi.hoisted(() => vi.fn())

vi.mock("../../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
  withOrgDbContext: (_orgId: string, fn: () => unknown) => fn(),
}))
vi.mock("../github/installation-write-client.js", () => ({
  commitFiles: commitFilesMock,
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
const resolveProfileMock = vi.hoisted(() =>
  vi.fn(async () => ({ handle: "ada", name: "Ada Lovelace" })),
)

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  listSlackConversationReplies: listRepliesMock,
  resolveSlackChannelInfo: resolveChannelInfoMock,
  resolveSlackUserDisplayName: vi.fn(async ({ userId }) => userId),
  resolveSlackUserProfile: resolveProfileMock,
  getSlackPermalink: getPermalinkMock,
}))

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

describe("captureSlackThread", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveChannelInfoMock.mockResolvedValue({
      channelId: "C1",
      name: "eng",
      isPrivate: false,
    })
    getPermalinkMock.mockResolvedValue(
      "https://acme.slack.com/archives/C1/p1710000000000100",
    )
    resolveProfileMock.mockResolvedValue({
      handle: "ada",
      name: "Ada Lovelace",
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
      threadPath: expect.stringContaining("slack/channels/eng--C1/threads/"),
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
            path: expect.stringContaining("slack/channels/eng--C1/index.md"),
          }),
          expect.objectContaining({
            path: expect.stringContaining("slack/channels/eng--C1/threads/"),
          }),
        ]),
      }),
    )
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

    const files = commitFilesMock.mock.calls[0]?.[0]?.files as Array<{
      path: string
      content: string
    }>
    const threadMd = files.find(
      (file) =>
        file.path.endsWith("/index.md") && file.path.includes("/threads/"),
    )
    expect(threadMd?.content).toContain("decision")
    expect(threadMd?.content).not.toContain("capturing engineering context")
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

    const files = commitFilesMock.mock.calls[0]?.[0]?.files as Array<{
      path: string
      content: string
    }>
    const threadMd = files.find(
      (file) =>
        file.path.endsWith("/index.md") && file.path.includes("/threads/"),
    )
    expect(threadMd?.path).toContain("/threads/2024/03/1710000000.000100/")
    expect(threadMd?.content).toContain('handle: "ada"')
    expect(threadMd?.content).toContain('name: "Ada Lovelace"')
    expect(threadMd?.content).toContain(
      'permalink: "https://acme.slack.com/archives/C1/p1710000000000100"',
    )
    expect(threadMd?.content).toMatch(/captured_at: "/)
  })

  it("does not persist url_private attachment links", async () => {
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

    const files = commitFilesMock.mock.calls[0]?.[0]?.files as Array<{
      path: string
      content: string
    }>
    const threadMd = files.find(
      (file) =>
        file.path.endsWith("/index.md") && file.path.includes("/threads/"),
    )
    expect(threadMd?.content).toContain("[secret.png](#file-F1)")
    expect(threadMd?.content).not.toContain("files.slack.com")
    expect(threadMd?.content).not.toContain("url_private")
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

  it("stubs Slack file permalinks instead of committing binaries", async () => {
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

    const files = commitFilesMock.mock.calls[0]?.[0]?.files as Array<{
      path: string
      content: string
      encoding?: string
    }>
    expect(files.every((file) => file.encoding !== "base64")).toBe(true)
    expect(files.some((file) => file.path.includes("/assets/"))).toBe(false)
    const threadMd = files.find(
      (file) =>
        file.path.endsWith("/index.md") && file.path.includes("/threads/"),
    )
    expect(threadMd?.content).toContain(
      "[diagram.png](https://acme.slack.com/files/U1/F1/diagram.png)",
    )
    expect(threadMd?.content).not.toContain("files.slack.com/files-pri")
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
