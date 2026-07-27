import { beforeEach, describe, expect, it, vi } from "vitest"

const getGithubInstallationByConnectionIdMock = vi.hoisted(() => vi.fn())
const listAllReposForInstallationMock = vi.hoisted(() => vi.fn())
const bulkCreateRepositoriesForOrgMock = vi.hoisted(() => vi.fn())
const runRepositoryIngestionWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/github-installation.js", () => ({
  getGithubInstallationByConnectionId: getGithubInstallationByConnectionIdMock,
  listAllReposForInstallation: listAllReposForInstallationMock,
}))

vi.mock("../../models/repositories.js", () => ({
  bulkCreateRepositoriesForOrg: bulkCreateRepositoriesForOrgMock,
}))

vi.mock("../enqueue-repository-ingestion.js", () => ({
  runRepositoryIngestionWorkflow: runRepositoryIngestionWorkflowMock,
}))

vi.mock("../../observability/logger.js", () => ({
  createLogger: () => ({}),
  getLogger: () => ({ error: vi.fn() }),
  withLogger: (_logger: unknown, fn: () => unknown) => fn(),
}))

import { syncGithubRepositories } from "./sync-github-repositories.js"

const installationRow = {
  id: "con_github",
  installationId: 123,
  orgId: "org_1",
  accountSlug: "acme",
  appSlug: null,
  ingestAllRepositories: false,
  includeFutureRepos: false,
  createdAt: new Date("2026-03-01T00:00:00.000Z"),
  updatedAt: new Date("2026-03-01T00:00:00.000Z"),
}

describe("syncGithubRepositories workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getGithubInstallationByConnectionIdMock.mockResolvedValue(installationRow)
    listAllReposForInstallationMock.mockResolvedValue([
      {
        id: 1,
        full_name: "acme/unlisted",
        html_url: "https://github.com/acme/unlisted",
        clone_url: "https://github.com/acme/unlisted.git",
        name: "unlisted",
        default_branch: "main",
      },
    ])
    bulkCreateRepositoriesForOrgMock.mockResolvedValue([])
    runRepositoryIngestionWorkflowMock.mockResolvedValue(undefined)
  })

  it("uses reposToSync when provided without listing all installation repos", async () => {
    const step = {
      run: async (_opts: { name: string }, fn: () => Promise<unknown>) =>
        fn(),
    }

    await syncGithubRepositories.fn({
      input: {
        orgId: "org_1",
        githubConnectionId: "con_github",
        reposToSync: [
          {
            name: "acme/alpha",
            gitUrl: "https://github.com/acme/alpha.git",
          },
        ],
      },
      step,
    } as never)

    expect(listAllReposForInstallationMock).not.toHaveBeenCalled()
    expect(bulkCreateRepositoriesForOrgMock).toHaveBeenCalledWith(
      "org_1",
      [
        {
          name: "acme/alpha",
          gitUrl: "https://github.com/acme/alpha.git",
        },
      ],
      { githubConnectionId: "con_github" },
    )
  })

  it("lists all repos when reposToSync is omitted", async () => {
    const step = {
      run: async (_opts: { name: string }, fn: () => Promise<unknown>) =>
        fn(),
    }

    await syncGithubRepositories.fn({
      input: {
        orgId: "org_1",
        githubConnectionId: "con_github",
      },
      step,
    } as never)

    expect(listAllReposForInstallationMock).toHaveBeenCalledWith(
      "org_1",
      "con_github",
      expect.any(Object),
    )
    expect(bulkCreateRepositoriesForOrgMock).toHaveBeenCalledWith(
      "org_1",
      [
        {
          name: "acme/unlisted",
          gitUrl: "https://github.com/acme/unlisted.git",
        },
      ],
      { githubConnectionId: "con_github" },
    )
  })
})
