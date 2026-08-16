import { beforeEach, describe, expect, it, vi } from "vitest"

const listOrgWorkspacesMock = vi.hoisted(() => vi.fn())
const persistResolvedDesiredShaMock = vi.hoisted(() => vi.fn())
const getInstallationOctokitForOrgMock = vi.hoisted(() => vi.fn())

vi.mock("../../../models/workspaces.js", () => ({
  listOrgWorkspaces: listOrgWorkspacesMock,
  persistResolvedDesiredSha: persistResolvedDesiredShaMock,
}))

vi.mock("../../../models/github-installation.js", () => ({
  getInstallationOctokitForOrg: getInstallationOctokitForOrgMock,
}))

import {
  persistWorkspaceTipsOnDefaultBranchPush,
  resolveGithubBranchTip,
} from "./github-workspace-tip.js"

describe("persistWorkspaceTipsOnDefaultBranchPush", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("persists the resolved tip and ignores payload after", async () => {
    listOrgWorkspacesMock.mockResolvedValue([
      {
        id: "ws_1",
        workspaceRepositoryUrl: "https://github.com/acme/docs.git",
        desiredGeneration: 2,
        desiredSha: "old",
      },
    ])
    persistResolvedDesiredShaMock.mockResolvedValue(true)
    const resolveTip = vi.fn(async () => "resolved-from-github")

    const persisted = await persistWorkspaceTipsOnDefaultBranchPush({
      orgId: "org_1",
      repoFullName: "acme/docs",
      defaultBranch: "main",
      payloadAfter: "do-not-persist-me",
      resolveTip,
    })

    expect(persisted).toBe(1)
    expect(resolveTip).toHaveBeenCalledWith("acme/docs", "main")
    expect(persistResolvedDesiredShaMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      resolvedTip: "resolved-from-github",
      expectedGeneration: 2,
      expectedUrl: "https://github.com/acme/docs.git",
    })
    expect(
      persistResolvedDesiredShaMock.mock.calls[0]?.[0].resolvedTip,
    ).not.toBe("do-not-persist-me")
  })
})

describe("resolveGithubBranchTip", () => {
  it("returns the ref SHA from Octokit", async () => {
    const getRef = vi.fn(async () => ({ data: { object: { sha: "abc123" } } }))
    getInstallationOctokitForOrgMock.mockResolvedValue({
      octokit: { rest: { git: { getRef } } },
    })
    const sha = await resolveGithubBranchTip({
      orgId: "org_1",
      githubConnectionId: "ghi_1",
      repoFullName: "acme/docs",
      branch: "develop",
      env: {} as never,
    })
    expect(sha).toBe("abc123")
    expect(getRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "docs",
      ref: "heads/develop",
    })
  })

  it("returns null when the App is missing", async () => {
    getInstallationOctokitForOrgMock.mockResolvedValue(undefined)
    await expect(
      resolveGithubBranchTip({
        orgId: "org_1",
        repoFullName: "acme/docs",
        branch: "main",
        env: {} as never,
      }),
    ).resolves.toBeNull()
  })
})
