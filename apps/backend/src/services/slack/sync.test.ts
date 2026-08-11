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

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  listSlackConversationReplies: listRepliesMock,
  resolveSlackChannelInfo: resolveChannelInfoMock,
  resolveSlackUserDisplayName: vi.fn(async ({ userId }) => userId),
  downloadSlackFile: vi.fn(),
}))

import { captureSlackThread } from "./sync.js"

const target = {
  id: "sst_1",
  orgId: "org_1",
  connectionId: "con_1",
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  setupPhase: "live" as const,
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
  appId: null,
  ownerUserId: null,
  status: "installed",
  lastEventPayload: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
}

describe("captureSlackThread", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    limitMock.mockResolvedValue([
      { name: "acme/context", githubConnectionId: "ghc_1" },
    ])
    commitFilesMock.mockResolvedValue({ commitSha: "sha123" })
  })

  it("commits the channel index and thread markdown for a captured thread", async () => {
    listRepliesMock.mockResolvedValue([
      {
        ts: "1710000000.000100",
        user: "U1",
        text: "hello world",
      },
    ])

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
    listRepliesMock.mockResolvedValue([
      { ts: "1710000000.000100", user: "U1", text: "decision" },
      {
        ts: "1710000000.000200",
        user: "U_BOT",
        text: "ctx| agent capturing engineering context…",
      },
    ])

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
    const threadMd = files.find((file) => file.path.endsWith("/index.md") &&
      file.path.includes("/threads/"))
    expect(threadMd?.content).toContain("decision")
    expect(threadMd?.content).not.toContain("capturing engineering context")
  })

  it("fails without committing when the thread has no messages", async () => {
    listRepliesMock.mockResolvedValue([])

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
