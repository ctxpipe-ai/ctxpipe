import { beforeEach, describe, expect, it, vi } from "vitest"

const getWorkspaceByIdMock = vi.hoisted(() => vi.fn())
const getWorkspaceCommitProjectionMock = vi.hoisted(() => vi.fn())
const listWorkspaceCommitShasMock = vi.hoisted(() => vi.fn())
const insertWorkspaceRepositoryCommitsMock = vi.hoisted(() => vi.fn())
const pruneWorkspaceRepositoryCommitsMock = vi.hoisted(() => vi.fn())
const upsertWorkspaceCommitProjectionMock = vi.hoisted(() => vi.fn())
const fetchGithubWorkspaceCommitsMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceById: getWorkspaceByIdMock,
}))

vi.mock("../../models/workspace-commits.js", () => ({
  getWorkspaceCommitProjection: getWorkspaceCommitProjectionMock,
  listWorkspaceCommitShas: listWorkspaceCommitShasMock,
  insertWorkspaceRepositoryCommits: insertWorkspaceRepositoryCommitsMock,
  pruneWorkspaceRepositoryCommits: pruneWorkspaceRepositoryCommitsMock,
  upsertWorkspaceCommitProjection: upsertWorkspaceCommitProjectionMock,
}))

vi.mock("./fetch-github-commits.js", () => ({
  fetchGithubWorkspaceCommits: fetchGithubWorkspaceCommitsMock,
}))

import { projectWorkspaceCommits } from "./project-workspace-commits.js"

const env = {} as never

describe("projectWorkspaceCommits", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_1",
      orgId: "org_1",
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      githubConnectionId: "con_1",
      desiredSha: "tip",
    })
    getWorkspaceCommitProjectionMock.mockResolvedValue(null)
    listWorkspaceCommitShasMock.mockResolvedValue(new Set())
    insertWorkspaceRepositoryCommitsMock.mockResolvedValue(undefined)
    pruneWorkspaceRepositoryCommitsMock.mockResolvedValue(undefined)
    upsertWorkspaceCommitProjectionMock.mockResolvedValue(undefined)
  })

  it("skips when the projection already matches the tip", async () => {
    getWorkspaceCommitProjectionMock.mockResolvedValue({
      headSha: "tip",
      backfillStatus: "ready",
    })
    await expect(
      projectWorkspaceCommits({ workspaceId: "ws_1", env }),
    ).resolves.toEqual({ status: "skipped" })
    expect(fetchGithubWorkspaceCommitsMock).not.toHaveBeenCalled()
  })

  it("marks non-GitHub remotes ready without fetching", async () => {
    getWorkspaceByIdMock.mockResolvedValue({
      id: "ws_1",
      orgId: "org_1",
      workspaceRepositoryUrl: "https://gitlab.com/acme/docs",
      githubConnectionId: null,
      desiredSha: "tip",
    })
    await expect(
      projectWorkspaceCommits({ workspaceId: "ws_1", env }),
    ).resolves.toEqual({ status: "ready" })
    expect(fetchGithubWorkspaceCommitsMock).not.toHaveBeenCalled()
    expect(upsertWorkspaceCommitProjectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        headSha: "tip",
        backfillStatus: "ready",
      }),
    )
  })

  it("inserts fetched commits and marks ready", async () => {
    fetchGithubWorkspaceCommitsMock.mockResolvedValue({
      ok: true,
      commits: [
        {
          sha: "new",
          committedAt: new Date("2026-08-01T00:00:00.000Z"),
          authorName: "Ada",
          subject: "feat",
          htmlUrl: null,
        },
      ],
    })
    await expect(
      projectWorkspaceCommits({ workspaceId: "ws_1", env }),
    ).resolves.toEqual({ status: "ready" })
    expect(insertWorkspaceRepositoryCommitsMock).toHaveBeenCalled()
    expect(pruneWorkspaceRepositoryCommitsMock).toHaveBeenCalled()
    expect(upsertWorkspaceCommitProjectionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headSha: "tip",
        backfillStatus: "ready",
      }),
    )
  })

  it("marks failed when GitHub cannot be reached", async () => {
    fetchGithubWorkspaceCommitsMock.mockResolvedValue({
      ok: false,
      commits: [],
    })
    await expect(
      projectWorkspaceCommits({ workspaceId: "ws_1", env }),
    ).resolves.toEqual({ status: "failed" })
    expect(upsertWorkspaceCommitProjectionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ backfillStatus: "failed" }),
    )
  })
})
