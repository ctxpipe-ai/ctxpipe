import { beforeEach, describe, expect, it, vi } from "vitest"

const findRepositoriesByNormalizedGitUrlsMock = vi.hoisted(() => vi.fn())
const bulkCreateRepositoriesForOrgMock = vi.hoisted(() => vi.fn())
const enqueueRepositoryIngestionWorkflowMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/repositories.js", () => ({
  findRepositoriesByNormalizedGitUrls: findRepositoriesByNormalizedGitUrlsMock,
  bulkCreateRepositoriesForOrg: bulkCreateRepositoriesForOrgMock,
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

  it("uses the last path segment for other hosts", () => {
    expect(
      repositoryNameFromGitUrl("https://gitlab.com/acme/group/app.git"),
    ).toBe("app")
  })
})

describe("ensureOrgRepositoryAndIngest", () => {
  const log = { error: vi.fn() }

  beforeEach(() => {
    findRepositoriesByNormalizedGitUrlsMock.mockReset()
    bulkCreateRepositoriesForOrgMock.mockReset()
    enqueueRepositoryIngestionWorkflowMock.mockReset()
    enqueueRepositoryIngestionWorkflowMock.mockResolvedValue(undefined)
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
    expect(enqueueRepositoryIngestionWorkflowMock).toHaveBeenCalledWith(
      { repositoryId: "repo_existing", orgId: "org_1" },
      log,
    )
  })
})
