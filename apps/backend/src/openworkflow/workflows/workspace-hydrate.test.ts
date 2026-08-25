import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  enqueueWorkspaceIndexMock,
  listLinkedRepositoriesMock,
  hydrateWorkspaceRow,
  getWorkspaceByIdMock,
  persistHydrateFailureMock,
  persistResolvedDesiredShaMock,
  resolveWorkspaceRepositoryTipMock,
  getMigrationExportShaMock,
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
    },
  }
  return {
    enqueueWorkspaceIndexMock: vi.fn().mockResolvedValue(undefined),
    listLinkedRepositoriesMock: vi.fn().mockResolvedValue([]),
    hydrateWorkspaceRow,
    getWorkspaceByIdMock: vi.fn().mockResolvedValue(hydrateWorkspaceRow),
    persistHydrateFailureMock: vi.fn().mockResolvedValue(undefined),
    persistResolvedDesiredShaMock: vi.fn().mockResolvedValue(true),
    resolveWorkspaceRepositoryTipMock: vi
      .fn()
      .mockResolvedValue("abc123def456"),
    getMigrationExportShaMock: vi.fn().mockResolvedValue("exportsha"),
  }
})

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({}),
}))

const orgTxDepth = vi.hoisted(() => ({ value: 0 }))
const tipInTx = vi.hoisted(() => ({ value: false, seen: false }))
const enqueueInTx = vi.hoisted(() => ({ value: false, seen: false }))

vi.mock("../../db/client.js", () => ({
  tryGetOrgDb: () => (orgTxDepth.value > 0 ? {} : undefined),
  tryGetOrgDbOrgId: () => (orgTxDepth.value > 0 ? "org_1" : undefined),
  assertNotInOrgDbContext: () => {
    if (orgTxDepth.value > 0) {
      throw new Error(
        "Outbound I/O cannot run inside withOrgDbContext; finish the SQL transaction first.",
      )
    }
  },
  getSystemDb: () => ({
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: "org_1", slug: "acme" }),
      },
    },
  }),
  withOrgDbContext: async (_orgId: string, fn: () => unknown) => {
    orgTxDepth.value += 1
    try {
      return await fn()
    } finally {
      orgTxDepth.value -= 1
    }
  },
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
  persistResolvedDesiredSha: persistResolvedDesiredShaMock,
}))

vi.mock("../../routes/webhooks/github/github-workspace-tip.js", () => ({
  resolveWorkspaceRepositoryTip: (...args: unknown[]) => {
    tipInTx.seen = true
    tipInTx.value = orgTxDepth.value > 0
    return resolveWorkspaceRepositoryTipMock(...args)
  },
}))

vi.mock("../../models/workspace-export.js", () => ({
  loadMigrationExportSource: vi.fn(),
}))

vi.mock("../enqueue-workspace-index.js", () => ({
  enqueueWorkspaceIndex: (...args: unknown[]) => {
    enqueueInTx.seen = true
    enqueueInTx.value = orgTxDepth.value > 0
    return enqueueWorkspaceIndexMock(...args)
  },
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
    orgTxDepth.value = 0
    tipInTx.seen = false
    tipInTx.value = false
    enqueueInTx.seen = false
    enqueueInTx.value = false
    listLinkedRepositoriesMock.mockResolvedValue([])
    getWorkspaceByIdMock.mockResolvedValue(hydrateWorkspaceRow)
    persistResolvedDesiredShaMock.mockResolvedValue(true)
    resolveWorkspaceRepositoryTipMock.mockResolvedValue("abc123def456")
    getMigrationExportShaMock.mockResolvedValue("exportsha")
  })

  it("does not throw getLogger when only index is lagging", async () => {
    const result = await hydrateFn.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })

    expect(result.reason).toBe("index_lag")
    expect(persistResolvedDesiredShaMock).not.toHaveBeenCalled()
  })

  it("fails when desiredSha is missing instead of resolving a tip", async () => {
    getWorkspaceByIdMock.mockResolvedValue({
      ...hydrateWorkspaceRow,
      desiredSha: null,
    })

    await expect(
      hydrateFn.fn({
        input: { orgId: "org_1", workspaceId: "ws_1" },
      }),
    ).rejects.toThrow(/git tip/)
    expect(resolveWorkspaceRepositoryTipMock).not.toHaveBeenCalled()
    expect(persistResolvedDesiredShaMock).not.toHaveBeenCalled()
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

  it("hydrates from git when the first export has not started", async () => {
    getMigrationExportShaMock.mockResolvedValue(null)
    getWorkspaceByIdMock.mockResolvedValue({
      ...hydrateWorkspaceRow,
      writeStatus: "read_only",
    })

    const result = await hydrateFn.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })

    expect(result.reason).not.toBe("migration_export_missing")
    expect(persistHydrateFailureMock).not.toHaveBeenCalled()
  })

  it("hydrates from git when write status is still unknown", async () => {
    getMigrationExportShaMock.mockResolvedValue(null)
    getWorkspaceByIdMock.mockResolvedValue({
      ...hydrateWorkspaceRow,
      writeStatus: "unknown",
    })

    const result = await hydrateFn.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })

    expect(result.reason).not.toBe("migration_export_missing")
    expect(persistHydrateFailureMock).not.toHaveBeenCalled()
  })

  it("hydrates a writable workspace while the first export is still queued", async () => {
    getMigrationExportShaMock.mockResolvedValue(null)
    getWorkspaceByIdMock.mockResolvedValue({
      ...hydrateWorkspaceRow,
      writeStatus: "writable",
    })

    const result = await hydrateFn.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })

    expect(result.reason).not.toBe("migration_export_waiting")
    expect(persistHydrateFailureMock).not.toHaveBeenCalled()
  })

  it("resolves GitHub tip and enqueues index outside the org SQL transaction", async () => {
    getWorkspaceByIdMock.mockResolvedValue({
      ...hydrateWorkspaceRow,
      desiredSha: null,
      indexedSha: null,
    })
    await hydrateFn.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })
    expect(tipInTx.seen).toBe(true)
    expect(tipInTx.value).toBe(false)
    expect(enqueueInTx.seen).toBe(true)
    expect(enqueueInTx.value).toBe(false)
  })
})
