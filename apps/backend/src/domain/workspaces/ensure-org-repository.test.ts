import { beforeEach, describe, expect, it, vi } from "vitest"

const findRepositoriesByNormalizedGitUrlsMock = vi.hoisted(() => vi.fn())
const bulkCreateRepositoriesForOrgMock = vi.hoisted(() => vi.fn())
const setRepositoryGithubConnectionIdMock = vi.hoisted(() => vi.fn())
const enqueueRepositoryIngestionWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/repositories.js", () => ({
  findRepositoriesByNormalizedGitUrls: findRepositoriesByNormalizedGitUrlsMock,
  bulkCreateRepositoriesForOrg: bulkCreateRepositoriesForOrgMock,
  setRepositoryGithubConnectionId: setRepositoryGithubConnectionIdMock,
}))

vi.mock("../../openworkflow/enqueue-repository-ingestion.js", () => ({
  enqueueRepositoryIngestionWorkflow: enqueueRepositoryIngestionWorkflowMock,
}))

import {
  ensureOrgRepositoryAndIngest,
  repositoryNameFromGitUrl,
} from "./ensure-org-repository.js"

describe("repositoryNameFromGitUrl", () => {
  it("uses owner/repo for GitHub URLs", () => {
    expect(repositoryNameFromGitUrl("https://github.com/acme/docs.git")).toBe(
      "acme/docs",
    )
  })

  it("uses host plus path for other hosts so names stay unique per org", () => {
    expect(
      repositoryNameFromGitUrl("https://gitlab.com/acme/group/app.git"),
    ).toBe("gitlab.com/acme/group/app")
    expect(repositoryNameFromGitUrl("https://gitlab.com/other/app.git")).toBe(
      "gitlab.com/other/app",
    )
    expect(
      repositoryNameFromGitUrl("https://git.example:8443/acme/app.git"),
    ).toBe("git.example:8443/acme/app")
  })
})

describe("ensureOrgRepositoryAndIngest", () => {
  const log = { error: vi.fn() }

  beforeEach(() => {
    findRepositoriesByNormalizedGitUrlsMock.mockReset()
    bulkCreateRepositoriesForOrgMock.mockReset()
    setRepositoryGithubConnectionIdMock.mockReset()
    enqueueRepositoryIngestionWorkflowMock.mockReset()
    enqueueRepositoryIngestionWorkflowMock.mockResolvedValue(undefined)
    setRepositoryGithubConnectionIdMock.mockResolvedValue(undefined)
  })

  it("creates a repositories row when none exists and enqueues ingestion", async () => {
    findRepositoriesByNormalizedGitUrlsMock.mockResolvedValueOnce([])
    bulkCreateRepositoriesForOrgMock.mockResolvedValue([
      {
        id: "repo_new",
        orgId: "org_1",
        gitUrl: "https://github.com/acme/docs",
      },
    ])

    const result = await ensureOrgRepositoryAndIngest({
      orgId: "org_1",
      gitUrl: "https://github.com/acme/docs.git",
      githubConnectionId: "con_gh",
      log,
    })

    expect(result).toEqual({ id: "repo_new", created: true })
    expect(bulkCreateRepositoriesForOrgMock).toHaveBeenCalledWith(
      "org_1",
      [{ name: "acme/docs", gitUrl: "https://github.com/acme/docs" }],
      { githubConnectionId: "con_gh" },
    )
    expect(enqueueRepositoryIngestionWorkflowMock).toHaveBeenCalledWith(
      { repositoryId: "repo_new", orgId: "org_1" },
      log,
    )
  })

  it("reuses an existing repositories row and still enqueues ingestion", async () => {
    findRepositoriesByNormalizedGitUrlsMock.mockResolvedValue([
      { id: "repo_existing", gitUrl: "https://github.com/acme/docs" },
    ])

    const result = await ensureOrgRepositoryAndIngest({
      orgId: "org_1",
      gitUrl: "https://github.com/acme/docs",
      log,
    })

    expect(result).toEqual({ id: "repo_existing", created: false })
    expect(bulkCreateRepositoriesForOrgMock).not.toHaveBeenCalled()
    expect(setRepositoryGithubConnectionIdMock).not.toHaveBeenCalled()
    expect(enqueueRepositoryIngestionWorkflowMock).toHaveBeenCalledWith(
      { repositoryId: "repo_existing", orgId: "org_1" },
      log,
    )
  })

  it("backfills github_connection_id on an existing row when known", async () => {
    findRepositoriesByNormalizedGitUrlsMock.mockResolvedValue([
      { id: "repo_existing", gitUrl: "https://github.com/acme/docs" },
    ])

    await ensureOrgRepositoryAndIngest({
      orgId: "org_1",
      gitUrl: "https://github.com/acme/docs",
      githubConnectionId: "con_gh",
      log,
    })

    expect(setRepositoryGithubConnectionIdMock).toHaveBeenCalledWith({
      repositoryId: "repo_existing",
      githubConnectionId: "con_gh",
    })
  })
})
