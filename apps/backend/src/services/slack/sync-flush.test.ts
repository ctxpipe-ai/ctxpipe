import { beforeEach, describe, expect, it, vi } from "vitest"
import { getSlackThreadDirPath } from "./converter.js"

const clearDirtyMock = vi.hoisted(() => vi.fn())
const listDirtyMock = vi.hoisted(() => vi.fn())
const commitFilesMock = vi.hoisted(() => vi.fn())
const listFilesInTreeMock = vi.hoisted(() => vi.fn())
const loadScopeMock = vi.hoisted(() => vi.fn())
const listRepliesMock = vi.hoisted(() => vi.fn())
const limitMock = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue([
      { name: "acme/ctxpipe-context", githubConnectionId: "con_github" },
    ]),
)

vi.mock("../../db/client.js", () => ({
  withOrgDbContext: (_orgId: string, run: () => unknown) => run(),
  getOrgDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: limitMock }),
      }),
    }),
  }),
}))

vi.mock("../../models/slack-connector.js", () => ({
  clearSlackDirtyThreads: clearDirtyMock,
  listReadySlackDirtyThreads: listDirtyMock,
  listSlackChannelsByConnectionId: vi.fn(),
}))

vi.mock("../github/installation-write-client.js", () => ({
  closePullRequest: vi.fn(),
  commitFiles: commitFilesMock,
  createPullRequestWithFiles: vi.fn(),
  getFileContent: vi.fn(),
  listFilesInTree: listFilesInTreeMock,
  parseGithubPullNumberFromUrl: vi.fn(),
}))

vi.mock("./config-from-repo.js", () => ({
  loadSlackScopeFromRepo: loadScopeMock,
  SLACK_CONFIG_PATH: "slack/config.yaml",
}))

vi.mock("./client.js", () => ({
  downloadSlackFile: vi.fn(),
  listSlackConversationHistory: vi.fn(),
  listSlackConversationReplies: listRepliesMock,
  resolveSlackUserDisplayName: vi.fn().mockResolvedValue("Ada"),
  SLACK_FILE_MAX_BYTES: 10 * 1024 * 1024,
}))

import { flushSlackDirtyThreads } from "./sync.js"

const connection = {
  id: "con_slack",
  orgId: "org_1",
  teamId: "T1",
}

const target = {
  id: "sst_1",
  orgId: "org_1",
  connectionId: "con_slack",
  repositoryId: "repo_1",
  branch: "main",
  enabled: true,
  setupPhase: "live",
  oldestDays: 90,
}

function dirtyRow(input: { id: string; threadTs: string }) {
  return {
    id: input.id,
    connectionId: "con_slack",
    channelId: "C1",
    threadTs: input.threadTs,
    firstDirtyAt: new Date(0),
    lastEventAt: new Date(0),
    revision: 1,
  }
}

async function flush() {
  return flushSlackDirtyThreads({
    orgId: "org_1",
    env: {} as never,
    connection: connection as never,
    target: target as never,
  })
}

describe("flushSlackDirtyThreads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadScopeMock.mockResolvedValue({
      teamId: "T1",
      oldestDays: 90,
      channels: [{ channelId: "C1", name: "general", isPrivate: false }],
    })
    commitFilesMock.mockResolvedValue({ commitSha: "abc123" })
    clearDirtyMock.mockResolvedValue(undefined)
  })

  it("deletes thread assets that disappeared from the latest Slack replies", async () => {
    const threadTs = "1704067200.000001"
    const threadDir = getSlackThreadDirPath({
      channelId: "C1",
      channelName: "general",
      threadTs,
    })
    const staleAsset = `${threadDir}/assets/F1--old.txt`
    listDirtyMock.mockResolvedValue([dirtyRow({ id: "dirty_1", threadTs })])
    listFilesInTreeMock.mockResolvedValue([
      { path: `${threadDir}/index.md` },
      { path: staleAsset },
    ])
    listRepliesMock.mockResolvedValue([
      { ts: threadTs, user: "U1", text: "attachment removed" },
    ])

    await expect(flush()).resolves.toMatchObject({ status: "completed" })
    expect(commitFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ deletePaths: [staleAsset] }),
    )
  })

  it("retains a deletion dirty row when another failure suppresses Git deletes", async () => {
    const deletedTs = "1704067200.000001"
    const failedTs = "1704067200.000002"
    const deletedDir = getSlackThreadDirPath({
      channelId: "C1",
      channelName: "general",
      threadTs: deletedTs,
    })
    listDirtyMock.mockResolvedValue([
      dirtyRow({ id: "dirty_deleted", threadTs: deletedTs }),
      dirtyRow({ id: "dirty_failed", threadTs: failedTs }),
    ])
    listFilesInTreeMock.mockResolvedValue([{ path: `${deletedDir}/index.md` }])
    listRepliesMock.mockImplementation(({ threadTs }: { threadTs: string }) => {
      if (threadTs === deletedTs) return Promise.resolve([])
      return Promise.reject(new Error("Slack unavailable"))
    })

    await expect(flush()).resolves.toMatchObject({
      status: "partial_failed",
    })
    expect(commitFilesMock).not.toHaveBeenCalled()
    expect(clearDirtyMock).not.toHaveBeenCalled()
  })
})
