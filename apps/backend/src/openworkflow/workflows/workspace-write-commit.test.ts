import { beforeEach, describe, expect, it, vi } from "vitest"

const persistWriteJobStartMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const persistHydrateFailureMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const persistResolvedDesiredShaMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(true),
)
const resolveWorkspaceRepositoryTipMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue("abc123def456"),
)
const loadMigrationExportSourceMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    firstWorkspaceId: null,
    workspaceByRepositoryId: new Map(),
    objects: [],
    claims: [],
  }),
)
const listFilesInTreeMock = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const listFilesAtShaMock = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const enqueueWorkspaceHydrateMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const runWorkflowWithWorkerWakeMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const orgTxDepth = vi.hoisted(() => ({ value: 0 }))
const tipInTx = vi.hoisted(() => ({ value: false, seen: false }))
const enqueueInTx = vi.hoisted(() => ({ value: false, seen: false }))

vi.mock("../../config/env.js", () => ({
  parseEnv: () => ({}),
}))

vi.mock("../../db/client.js", () => ({
  tryGetOrgDb: () => (orgTxDepth.value > 0 ? {} : undefined),
  tryGetOrgDbOrgId: () => (orgTxDepth.value > 0 ? "org_1" : undefined),
  assertNotInOrgDbContext: () => undefined,

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

vi.mock("../../lib/id.js", () => ({
  generateObjectId: () => "wjob_test",
}))

vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceById: vi.fn().mockResolvedValue({
    id: "ws_1",
    orgId: "org_1",
    slug: "docs",
    displayName: "Docs",
    workspaceRepositoryUrl: "https://github.com/acme/docs",
    githubConnectionId: "con_1",
    desiredGeneration: 1,
    desiredSha: null,
    writeStatus: "writable",
    hydrateStatus: "pending",
    hydratePhases: null,
    indexedSha: null,
    activeProjectionUrl: null,
    activeProjectionSha: null,
  }),
  persistWriteJobStart: persistWriteJobStartMock,
  persistLastJobAt: vi.fn().mockResolvedValue(undefined),
  getWriteJobCommitSha: vi.fn().mockResolvedValue(null),
  persistResolvedDesiredSha: persistResolvedDesiredShaMock,
  persistWriteJobCommitSha: vi.fn().mockResolvedValue(undefined),
  persistWriteJobStatus: vi.fn().mockResolvedValue(undefined),
  persistWriteStatus: vi.fn().mockResolvedValue(undefined),
  persistHydrateFailure: persistHydrateFailureMock,
  listLinkedRepositories: vi.fn().mockResolvedValue([]),
  listKnowledgeUnitPaths: vi.fn().mockResolvedValue([]),
  claimSandboxInstance: vi.fn(async (input: { id: string }) => ({
    record: input,
    inserted: true,
  })),
  persistSandboxInstance: vi.fn(async () => {}),
  deleteSandboxInstance: vi.fn(async () => {}),
  listSandboxInstances: vi.fn(async () => []),
  heartbeatSandboxInstance: vi.fn(async () => {}),
  getSandboxInstance: vi.fn(async () => null),
}))

vi.mock("../../models/workspace-export.js", () => ({
  loadMigrationExportSource: loadMigrationExportSourceMock,
}))

vi.mock("../../models/github-installation.js", () => ({
  getRepoReadCloneToken: vi.fn().mockResolvedValue("tok"),
}))

vi.mock("../../routes/webhooks/github/github-workspace-tip.js", () => ({
  resolveGithubDefaultBranch: vi.fn().mockResolvedValue("main"),
  resolveWorkspaceRepositoryTip: (...args: unknown[]) => {
    tipInTx.seen = true
    tipInTx.value = orgTxDepth.value > 0
    return resolveWorkspaceRepositoryTipMock(...args)
  },
}))

vi.mock("../../services/github/installation-write-client.js", () => ({
  commitFiles: vi.fn(),
  getCommitTimestamp: vi.fn(),
  getFileContent: vi.fn().mockResolvedValue(null),
  listFilesAtSha: listFilesAtShaMock,
  listFilesInTree: listFilesInTreeMock,
}))

vi.mock("../enqueue-workspace-hydrate.js", () => ({
  enqueueWorkspaceHydrate: (...args: unknown[]) => {
    enqueueInTx.seen = true
    enqueueInTx.value = orgTxDepth.value > 0
    return enqueueWorkspaceHydrateMock(...args)
  },
}))

vi.mock("../enqueue-workspace-write-commit.js", () => ({
  enqueueWorkspaceWriteCommit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../client.js", () => ({
  runWorkflowWithWorkerWake: runWorkflowWithWorkerWakeMock,
}))

vi.mock("openworkflow", () => ({
  defineWorkflow: (
    _opts: unknown,
    handler: (args: {
      input: {
        orgId: string
        workspaceId: string
        kind: string
      }
    }) => Promise<unknown>,
  ) => ({
    fn: handler,
    spec: { name: "workspace-write-commit" },
  }),
}))

import { workspaceWriteCommit } from "./workspace-write-commit.js"

describe("workspaceWriteCommit workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    orgTxDepth.value = 0
    tipInTx.seen = false
    tipInTx.value = false
    enqueueInTx.seen = false
    enqueueInTx.value = false
    persistResolvedDesiredShaMock.mockResolvedValue(true)
    resolveWorkspaceRepositoryTipMock.mockResolvedValue("abc123def456")
    loadMigrationExportSourceMock.mockResolvedValue({
      firstWorkspaceId: null,
      workspaceByRepositoryId: new Map(),
      objects: [],
      claims: [],
    })
    listFilesInTreeMock.mockResolvedValue([])
    listFilesAtShaMock.mockResolvedValue([])
  })

  it("records the GitHub tip on a first-create no-op export", async () => {
    const wf = workspaceWriteCommit as unknown as {
      fn: (args: {
        input: {
          orgId: string
          workspaceId: string
          kind: "migration_export"
        }
      }) => Promise<{ exportSha?: string | null }>
    }

    const result = await wf.fn({
      input: {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "migration_export",
      },
    })

    expect(result.exportSha).toBe("abc123def456")
    expect(persistResolvedDesiredShaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        resolvedTip: "abc123def456",
      }),
    )
    expect(tipInTx.seen).toBe(true)
    expect(tipInTx.value).toBe(false)
    expect(enqueueInTx.seen).toBe(true)
    expect(enqueueInTx.value).toBe(false)
  })

  it("persists hydrate failure then rethrows when the job dies after start", async () => {
    persistWriteJobStartMock.mockRejectedValueOnce(
      new Error("write job start failed"),
    )
    const wf = workspaceWriteCommit as unknown as {
      fn: (args: {
        input: {
          orgId: string
          workspaceId: string
          kind: "migration_export"
        }
      }) => Promise<unknown>
    }

    await expect(
      wf.fn({
        input: {
          orgId: "org_1",
          workspaceId: "ws_1",
          kind: "migration_export",
        },
      }),
    ).rejects.toThrow("write job start failed")
    expect(persistHydrateFailureMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      message: "write job start failed",
    })
  })

  it("does not finish a no-op export until hydrate enqueue settles", async () => {
    let settleHydrate: (() => void) | undefined
    enqueueWorkspaceHydrateMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleHydrate = resolve
        }),
    )
    const wf = workspaceWriteCommit as unknown as {
      fn: (args: {
        input: {
          orgId: string
          workspaceId: string
          kind: "migration_export"
        }
      }) => Promise<{ exportSha?: string | null }>
    }
    const pending = wf.fn({
      input: {
        orgId: "org_1",
        workspaceId: "ws_1",
        kind: "migration_export",
      },
    })
    let finished = false
    void pending.then(() => {
      finished = true
    })
    await vi.waitFor(() => {
      expect(enqueueWorkspaceHydrateMock).toHaveBeenCalled()
    })
    expect(finished).toBe(false)
    settleHydrate?.()
    await pending
    expect(finished).toBe(true)
  })
})
