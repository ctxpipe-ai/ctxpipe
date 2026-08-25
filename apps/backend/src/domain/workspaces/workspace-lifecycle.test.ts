import { beforeEach, describe, expect, it, vi } from "vitest"

const createWorkspaceMock = vi.hoisted(() => vi.fn())
const updateWorkspaceMock = vi.hoisted(() => vi.fn())
const resolveWorkspaceGithubConnectionIdMock = vi.hoisted(() => vi.fn())
const ensureOrgRepositoryForGitUrlMock = vi.hoisted(() => vi.fn())
const destroySandboxesForWorkspaceMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceHydrateMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceTipCheckMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceWriteCommitMock = vi.hoisted(() => vi.fn())

vi.mock("../../models/workspaces.js", () => ({
  createWorkspace: createWorkspaceMock,
  updateWorkspace: updateWorkspaceMock,
}))

vi.mock("./bind-github-connection.js", () => ({
  resolveWorkspaceGithubConnectionId: resolveWorkspaceGithubConnectionIdMock,
}))

vi.mock("./ensure-org-repository.js", () => ({
  ensureOrgRepositoryForGitUrl: ensureOrgRepositoryForGitUrlMock,
}))

vi.mock("./sandbox-registry.js", () => ({
  destroySandboxesForWorkspace: destroySandboxesForWorkspaceMock,
}))

vi.mock("../../openworkflow/enqueue-workspace-hydrate.js", () => ({
  enqueueWorkspaceHydrate: enqueueWorkspaceHydrateMock,
}))

vi.mock("../../openworkflow/enqueue-workspace-tip-check.js", () => ({
  enqueueWorkspaceTipCheck: enqueueWorkspaceTipCheckMock,
}))

vi.mock("../../openworkflow/enqueue-workspace-write-commit.js", () => ({
  enqueueWorkspaceWriteCommit: enqueueWorkspaceWriteCommitMock,
}))

import {
  createWorkspaceLifecycle,
  relinkWorkspaceLifecycle,
  renameWorkspaceLifecycle,
} from "./workspace-lifecycle.js"

const workspace = {
  id: "ws_1",
  orgId: "org_1",
  slug: "docs",
  displayName: "docs",
  workspaceRepositoryUrl: "https://github.com/acme/docs",
  githubConnectionId: null,
  desiredGeneration: 1,
  desiredSha: null,
  activeProjectionUrl: null,
  activeProjectionSha: null,
  indexedSha: null,
  writeStatus: "unknown",
  hydrateStatus: "pending",
  hydrateError: null,
  lastJobAt: null,
  hydratePhases: null,
  readOnlyReason: null,
  autoLinkGitUrls: [] as string[],
  createdAt: new Date("2026-08-25T00:00:00.000Z"),
  updatedAt: new Date("2026-08-25T00:00:00.000Z"),
}

describe("workspace lifecycle", () => {
  const log = { error: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    resolveWorkspaceGithubConnectionIdMock.mockResolvedValue(null)
    ensureOrgRepositoryForGitUrlMock.mockResolvedValue(null)
    destroySandboxesForWorkspaceMock.mockResolvedValue(0)
    enqueueWorkspaceHydrateMock.mockResolvedValue(undefined)
    enqueueWorkspaceTipCheckMock.mockResolvedValue(undefined)
    enqueueWorkspaceWriteCommitMock.mockResolvedValue({ started: true })
    createWorkspaceMock.mockResolvedValue(workspace)
    updateWorkspaceMock.mockResolvedValue(workspace)
  })

  it("creates without org repository-ingestion", async () => {
    const created = await createWorkspaceLifecycle({
      orgId: "org_1",
      gitUrl: "https://github.com/acme/docs.git",
      log,
    })
    expect(created.id).toBe("ws_1")
    expect(ensureOrgRepositoryForGitUrlMock).toHaveBeenCalled()
    expect(enqueueWorkspaceWriteCommitMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "migration_export" }),
      log,
    )
  })

  it("enqueues relink jobs only when the canonical URL changes", async () => {
    const unchanged = await relinkWorkspaceLifecycle({
      slug: "docs",
      current: workspace,
      orgId: "org_1",
      workspaceRepositoryUrl: "https://github.com/acme/docs.git",
      persistConnection: false,
      bindingSubmitted: true,
      log,
    })
    expect(unchanged.changed).toBe(false)
    expect(enqueueWorkspaceWriteCommitMock).not.toHaveBeenCalled()
    expect(destroySandboxesForWorkspaceMock).not.toHaveBeenCalled()

    updateWorkspaceMock.mockResolvedValue({
      ...workspace,
      workspaceRepositoryUrl: "https://github.com/acme/other",
      desiredGeneration: 2,
    })
    const changed = await relinkWorkspaceLifecycle({
      slug: "docs",
      current: workspace,
      orgId: "org_1",
      workspaceRepositoryUrl: "https://github.com/acme/other.git",
      persistConnection: false,
      bindingSubmitted: true,
      log,
    })
    expect(changed.changed).toBe(true)
    expect(enqueueWorkspaceWriteCommitMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "bootstrap" }),
      log,
    )
    expect(enqueueWorkspaceHydrateMock).toHaveBeenCalled()
    expect(enqueueWorkspaceTipCheckMock).toHaveBeenCalled()
  })

  it("renames by enqueueing ops_folder_map instead of writing display name", async () => {
    await renameWorkspaceLifecycle({
      orgId: "org_1",
      workspaceId: "ws_1",
      log,
    })
    expect(enqueueWorkspaceWriteCommitMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ops_folder_map" }),
      log,
    )
  })
})
