import { beforeEach, describe, expect, it, vi } from "vitest"

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
  persistWriteJobStart: vi.fn().mockResolvedValue(undefined),
  persistLastJobAt: vi.fn().mockResolvedValue(undefined),
  getWriteJobCommitSha: vi.fn().mockResolvedValue(null),
  persistResolvedDesiredSha: persistResolvedDesiredShaMock,
  persistWriteJobCommitSha: vi.fn().mockResolvedValue(undefined),
  persistWriteStatus: vi.fn().mockResolvedValue(undefined),
  listLinkedRepositories: vi.fn().mockResolvedValue([]),
  listKnowledgeUnitPaths: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../models/workspace-export.js", () => ({
  loadMigrationExportSource: loadMigrationExportSourceMock,
}))

vi.mock("../../models/github-installation.js", () => ({
  getRepoReadCloneToken: vi.fn().mockResolvedValue("tok"),
}))

vi.mock("../../routes/webhooks/github/github-workspace-tip.js", () => ({
  resolveGithubDefaultBranch: vi.fn().mockResolvedValue("main"),
  resolveWorkspaceRepositoryTip: resolveWorkspaceRepositoryTipMock,
}))

vi.mock("../../services/github/installation-write-client.js", () => ({
  commitFiles: vi.fn(),
  getCommitTimestamp: vi.fn(),
  getFileContent: vi.fn().mockResolvedValue(null),
  listFilesAtSha: listFilesAtShaMock,
  listFilesInTree: listFilesInTreeMock,
}))

vi.mock("../enqueue-workspace-hydrate.js", () => ({
  enqueueWorkspaceHydrate: enqueueWorkspaceHydrateMock,
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
  })
})
