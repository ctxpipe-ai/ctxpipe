import { beforeEach, describe, expect, it, vi } from "vitest"

const enqueueWorkspaceIndexMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
)
const listLinkedRepositoriesMock = vi.hoisted(() => vi.fn().mockResolvedValue([]))

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
  getWorkspaceById: vi.fn().mockResolvedValue({
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
  }),
  listLinkedRepositories: listLinkedRepositoriesMock,
  listWorkspaceKnowledgeUnits: vi.fn(),
  commitHydrateProjection: vi.fn(),
  persistHydratePhases: vi.fn(),
  persistUnitEmbeddings: vi.fn(),
  countWriteJobAttempts: vi.fn(),
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

describe("workspaceHydrate workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listLinkedRepositoriesMock.mockResolvedValue([])
  })

  it("does not throw getLogger when only index is lagging", async () => {
    const wf = workspaceHydrate as unknown as {
      fn: (args: {
        input: { orgId: string; workspaceId: string }
      }) => Promise<{ reason?: string }>
    }

    const result = await wf.fn({
      input: { orgId: "org_1", workspaceId: "ws_1" },
    })

    expect(result.reason).toBe("index_lag")
  })
})
