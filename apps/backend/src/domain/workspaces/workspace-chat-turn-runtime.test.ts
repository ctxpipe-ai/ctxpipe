import { beforeEach, describe, expect, it, vi } from "vitest"

const getChatSandboxMock = vi.hoisted(() => vi.fn())
const resolveGithubDefaultBranchMock = vi.hoisted(() => vi.fn())
const getRepoReadCloneTokenMock = vi.hoisted(() => vi.fn())
const githubRefExistsMock = vi.hoisted(() => vi.fn())

vi.mock("./sandbox-registry.js", () => ({
  getChatSandbox: getChatSandboxMock,
}))

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

import { resolveWorkspaceChatTurnRuntime } from "./workspace-chat-turn-runtime.js"
import type { Env } from "../../config/env.js"

describe("resolveWorkspaceChatTurnRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getChatSandboxMock.mockReturnValue(null)
    resolveGithubDefaultBranchMock.mockResolvedValue("main")
    getRepoReadCloneTokenMock.mockResolvedValue("tok")
    githubRefExistsMock.mockResolvedValue(false)
  })

  it("skips GitHub when the conversation sandbox is already a worktree", async () => {
    getChatSandboxMock.mockReturnValue({
      exec: vi.fn(async () => ({ stdout: "true", stderr: "", exitCode: 0 })),
    })
    const runtime = await resolveWorkspaceChatTurnRuntime({
      conversation: {
        id: "conv_warm",
        orgId: "org_1",
        workspaceId: "ws_1",
        lastBranch: "main",
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
    expect(runtime.cloneToken).toBeNull()
    expect(runtime.defaultBranch).toBe("main")
    expect(resolveGithubDefaultBranchMock).not.toHaveBeenCalled()
    expect(getRepoReadCloneTokenMock).not.toHaveBeenCalled()
    expect(githubRefExistsMock).not.toHaveBeenCalled()
  })

  it("resolves GitHub when no warm checkout exists", async () => {
    await resolveWorkspaceChatTurnRuntime({
      conversation: {
        id: "conv_cold",
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
    expect(resolveGithubDefaultBranchMock).toHaveBeenCalled()
    expect(getRepoReadCloneTokenMock).toHaveBeenCalled()
  })
})
