import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  getOrgDb: vi.fn(),
  getRepositoryForOrg: vi.fn(),
  getSystemDb: vi.fn(),
  mergeConfig: vi.fn(
    (_config: Record<string, unknown>, patch: Record<string, unknown>) => patch,
  ),
}))

vi.mock("../db/client.js", () => ({
  getOrgDb: mocks.getOrgDb,
  getSystemDb: mocks.getSystemDb,
}))

vi.mock("./connection-rows.js", () => ({
  mergeGithubConnectionConfig: mocks.mergeConfig,
}))

vi.mock("./github-installation.js", () => ({
  getGithubConnectionRow: mocks.getConnection,
}))

vi.mock("./repositories.js", () => ({
  DEFAULT_CHECKOUT_KEY: "default",
  getRepositoryForOrg: mocks.getRepositoryForOrg,
}))

import { bindGithubPrMirror } from "./github-pr-mirror.js"

describe("bindGithubPrMirror", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConnection.mockResolvedValue({
      id: "con_gh",
      orgId: "org_1",
      config: {},
    })
  })

  it("binds a context repository created in the active org transaction", async () => {
    const repository = {
      id: "repo_ctx",
      orgId: "org_1",
      name: "acme/ctxpipe-context",
      gitUrl: "https://github.com/acme/ctxpipe-context.git",
      githubConnectionId: "con_gh",
    }
    const limit = vi.fn().mockResolvedValue([repository])
    const where = vi.fn().mockReturnValue({ limit })
    const from = vi.fn().mockReturnValue({ where })
    const select = vi.fn().mockReturnValue({ from })
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const set = vi.fn().mockReturnValue({ where: updateWhere })
    const update = vi.fn().mockReturnValue({ set })
    mocks.getOrgDb.mockReturnValue({ select, update })
    mocks.getRepositoryForOrg.mockResolvedValue(null)
    mocks.getSystemDb.mockImplementation(() => {
      throw new Error("system DB cannot see the uncommitted repository")
    })

    await expect(
      bindGithubPrMirror({
        orgId: "org_1",
        connectionId: "con_gh",
        repositoryId: "repo_ctx",
        branch: "main",
      }),
    ).resolves.toMatchObject({
      connectionId: "con_gh",
      orgId: "org_1",
      repositoryId: "repo_ctx",
      repositoryName: "acme/ctxpipe-context",
      enabled: true,
      setupPhase: "initial_sync",
    })
    expect(update).toHaveBeenCalled()
  })
})
