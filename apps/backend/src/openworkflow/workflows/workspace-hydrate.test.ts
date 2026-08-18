import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  enqueueWorkspaceIndexMock,
  listLinkedRepositoriesMock,
  hydrateWorkspaceRow,
  getWorkspaceByIdMock,
  persistHydrateFailureMock,
  persistHydrateMessageMock,
  persistResolvedDesiredShaMock,
  resolveWorkspaceRepositoryTipMock,
  getMigrationExportShaMock,
  getLatestMigrationExportJobStatusMock,
} = vi.hoisted(() => {
  const hydrateWorkspaceRow = {
    id: "ws_1",
    orgId: "org_1",
    workspaceRepositoryUrl: "https://github.com/acme/docs",
    githubConnectionId: "con_1",
    desiredGeneration: 1,
    desiredSha: "abc123def456",
    activeProjectionUrl: "https://github.com/acme/docs",
    activeProjectionSha: "abc123def456",
    indexedSha: null,
    hydratePhases: {
      url: "https://github.com/acme/docs",
      sha: "abc123def456",
      embeddings: true,
      graph: true,
      remainders: true,
    },
  }
  return {
    enqueueWorkspaceIndexMock: vi.fn().mockResolvedValue(undefined),
    listLinkedRepositoriesMock: vi.fn().mockResolvedValue([]),
    hydrateWorkspaceRow,
    getWorkspaceByIdMock: vi.fn().mockResolvedValue(hydrateWorkspaceRow),
    persistHydrateFailureMock: vi.fn().mockResolvedValue(undefined),
    persistHydrateMessageMock: vi.fn().mockResolvedValue(undefined),
    persistResolvedDesiredShaMock: vi.fn().mockResolvedValue(true),
    getLatestMigrationExportJobStatusMock: vi.fn().mockResolvedValue(null),
    resolveWorkspaceRepositoryTipMock: vi
      .fn()
      .mockResolvedValue("abc123def456"),
    getMigrationExportShaMock: vi.fn().mockResolvedValue("exportsha"),
  }
})

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({}),
}))

vi.mock("../../db/client.js", () => ({
  getSystemDb: () => ({
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: "org_1", slug: "acme" }),
      },
    },
  }),
  withOrgDbContext: (_orgId: string, fn: () => unknown) =>
    Promise.resolve(fn()),
}))

vi.mock("../../auth/withAuth.js", () => ({
  withOrgIdContext: (_org: unknown, fn: () => unknown) => fn(),
}))

vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceById: getWorkspaceByIdMock,
  getMigrationExportSha: getMigrationExportShaMock,
  listLinkedRepositories: listLinkedRepositoriesMock,
  listWorkspaceKnowledgeUnits: vi.fn(),
  commitHydrateProjection: vi.fn(),
  persistHydratePhases: vi.fn(),
  persistUnitEmbeddings: vi.fn(),
  countWriteJobAttempts: vi.fn(),
  persistHydrateFailure: persistHydrateFailureMock,
  persistHydrateMessage: persistHydrateMessageMock,
  persistResolvedDesiredSha: persistResolvedDesiredShaMock,
  getLatestMigrationExportJobStatus: getLatestMigrationExportJobStatusMock,
}))

vi.mock("../../routes/webhooks/github/github-workspace-tip.js", () => ({
  resolveWorkspaceRepositoryTip: resolveWorkspaceRepositoryTipMock,
}))

vi.mock("../../models/workspace-export.js", () => ({
  loadMigrationExportSource: vi.fn(),
}))

vi.mock("../enqueue-workspace-index.js", () => ({
  enqueueWorkspaceIndex: enqueueWorkspaceIndexMock,
}))

vi.mock("../../retrieval/services/graphProjection.js", () => ({
  projectClaimsFromState: vi.fn(),
}))

vi.mock("../../retrieval/services/modelProvider.js", () => ({
  generateEmbeddings: vi.fn(),
}))

vi.mock("../../services/git/clone-tree.js", () => ({
  listMarkdownFilesAtGitSha: vi.fn(),
}))

vi.mock("../../services/github/installation-write-client.js", () => ({
  getCommitTimestamp: vi.fn(),
  getFileContent: vi.fn(),
  listFilesAtSha: vi.fn(),
}))

vi.mock("openworkflow", () => ({
  defineWorkflow: (
    _opts: unknown,
    handler: (args: {
      input: { orgId: string; workspaceId: string }
    }) => Promise<unknown>,
  ) => ({
    fn: handler,
    spec: { name: "workspace-hydrate" },
  }),
}))

import { workspaceHydrate } from "./workspace-hydrate.js"

const hydrateFn = workspaceHydrate as unknown as {
  fn: (args: {
    input: { orgId: string; workspaceId: string }
  }) => Promise<{ reason?: string }>
}

describe("workspaceHydrate workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listLinkedRepositoriesMock.mockResolvedValue([])
    getWorkspaceByIdMock.mockResolvedValue(hydrateWorkspaceRow)
    persistResolvedDesiredShaMock.mockResolvedValue(true)
    resolveWorkspaceRepositoryTipMock.mockResolvedValue("abc123def456")
    getMigrationExportShaMock.mockResolvedValue("exportsha")
    getLatestMigrationExportJobStatusMock.mockResolvedValue(null)
  })

  it("does not throw getLogger when only index is lagging", async () => {
    const result = await hydrateFn.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })

    expect(result.reason).toBe("index_lag")
    expect(persistResolvedDesiredShaMock).not.toHaveBeenCalled()
  })

  it("resolves and persists the tip when desiredSha is missing", async () => {
    getWorkspaceByIdMock.mockResolvedValue({
      ...hydrateWorkspaceRow,
      desiredSha: null,
    })

    const result = await hydrateFn.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })

    expect(result.reason).toBe("index_lag")
    expect(result.reason).not.toBe("desired_sha_missing")
    expect(resolveWorkspaceRepositoryTipMock).toHaveBeenCalledWith({
      orgId: "org_1",
      githubConnectionId: "con_1",
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      env: {},
    })
    expect(persistResolvedDesiredShaMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      resolvedTip: "abc123def456",
      expectedGeneration: 1,
      expectedUrl: "https://github.com/acme/docs",
      expectedDesiredSha: null,
    })
  })

  it("persists hydrate failure when the tip cannot be resolved", async () => {
    getWorkspaceByIdMock.mockResolvedValue({
      ...hydrateWorkspaceRow,
      desiredSha: null,
    })
    resolveWorkspaceRepositoryTipMock.mockResolvedValue(null)

    await expect(
      hydrateFn.fn({ input: { orgId: "org_1", workspaceId: "ws_1" } }),
    ).rejects.toThrow(
      "Could not resolve the git tip for this workspace repository.",
    )
    expect(persistResolvedDesiredShaMock).not.toHaveBeenCalled()
    expect(persistHydrateFailureMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      message: "Could not resolve the git tip for this workspace repository.",
    })
  })

  it("persists hydrate failure then rethrows when the workspace load dies", async () => {
    getWorkspaceByIdMock.mockRejectedValueOnce(new Error("db down"))

    await expect(
      hydrateFn.fn({ input: { orgId: "org_1", workspaceId: "ws_1" } }),
    ).rejects.toThrow("db down")
    expect(persistHydrateFailureMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      message: "db down",
    })
  })

  it("does not activate a projection before the migration-export SHA exists", async () => {
    getMigrationExportShaMock.mockResolvedValue(null)
    const wf = workspaceHydrate as unknown as {
      fn: (args: {
        input: { orgId: string; workspaceId: string }
      }) => Promise<{ reason?: string; hydrated?: boolean }>
    }

    const result = await wf.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })

    expect(result).toEqual({
      hydrated: false,
      reason: "migration_export_missing",
    })
    expect(persistHydrateFailureMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      message: "The first knowledge export has not landed in git yet.",
    })
  })

  it("keeps pending while a migration export is still queued", async () => {
    getMigrationExportShaMock.mockResolvedValue(null)
    getLatestMigrationExportJobStatusMock.mockResolvedValue("queued")

    const result = await hydrateFn.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })

    expect(result).toEqual({
      hydrated: false,
      reason: "migration_export_missing",
    })
    expect(persistHydrateFailureMock).not.toHaveBeenCalled()
    expect(persistHydrateMessageMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      message: "Waiting for the first knowledge export to land in git.",
    })
  })
})
