import { beforeEach, describe, expect, it, vi } from "vitest"

const resolveGithubDefaultBranchMock = vi.hoisted(() => vi.fn())
const getRepoReadCloneTokenMock = vi.hoisted(() => vi.fn())
const githubRefExistsMock = vi.hoisted(() => vi.fn())

vi.mock("../../routes/webhooks/github/github-workspace-tip.js", () => ({
  resolveGithubDefaultBranch: resolveGithubDefaultBranchMock,
}))

vi.mock("../../models/github-installation.js", () => ({
  getRepoReadCloneToken: getRepoReadCloneTokenMock,
}))

vi.mock("../../services/github/installation-write-client.js", () => ({
  githubRefExists: githubRefExistsMock,
}))

vi.mock("../../models/conversations.js", () => ({
  persistConversationLastBranch: vi.fn(async () => {}),
}))

import type { Env } from "../../config/env.js"
import { resolveWorkspaceChatTurnRuntime } from "./workspace-chat-turn-runtime.js"

describe("resolveWorkspaceChatTurnRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveGithubDefaultBranchMock.mockResolvedValue("main")
    getRepoReadCloneTokenMock.mockResolvedValue("tok")
    githubRefExistsMock.mockResolvedValue(false)
  })

  it("resolves GitHub for every send instead of a process-global sandbox", async () => {
    const runtime = await resolveWorkspaceChatTurnRuntime({
      conversation: {
        id: "conv_1",
        orgId: "org_1",
        workspaceId: "ws_1",
        lastBranch: null,
      },
      workspace: {
        id: "ws_1",
        orgId: "org_1",
        workspaceRepositoryUrl: "https://github.com/acme/docs",
        writeStatus: "read_only",
        desiredSha: "abc",
      },
      env: {} as Env,
    })
    expect(runtime.cloneToken).toBe("tok")
    expect(runtime.desiredUrl).toBe("https://github.com/acme/docs")
    expect(resolveGithubDefaultBranchMock).toHaveBeenCalled()
    expect(getRepoReadCloneTokenMock).toHaveBeenCalled()
  })
})
