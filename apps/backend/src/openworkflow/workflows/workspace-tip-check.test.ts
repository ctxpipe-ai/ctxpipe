import { beforeEach, describe, expect, it, vi } from "vitest"

const listOrgWorkspacesMock = vi.hoisted(() => vi.fn())
const listMigrationExportShasMock = vi.hoisted(() => vi.fn())
const listOrgLinkedRepositoriesMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceCutoverMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceHydrateMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceIndexMock = vi.hoisted(() => vi.fn())

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
  getOrgDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
  }),
}))

vi.mock("../../models/workspaces.js", () => ({
  listOrgWorkspaces: listOrgWorkspacesMock,
  listMigrationExportShas: listMigrationExportShasMock,
  listOrgLinkedRepositories: listOrgLinkedRepositoriesMock,
  listPausedWriteJobs: vi.fn().mockResolvedValue([]),
  claimPausedWriteJob: vi.fn(),
  getWorkspaceById: vi.fn(),
  persistLinkedDesiredSha: vi.fn(),
  persistResolvedDesiredSha: vi.fn(),
  persistWriteStatus: vi.fn(),
}))

vi.mock("../../domain/workspaces/sandbox-registry.js", () => ({
  chatSandboxesDueForDestroy: () => [],
  jobSandboxesDueForDestroy: () => [],
  destroySandboxesForConversation: vi.fn(),
  destroySandboxesForWorkspace: vi.fn(),
}))

vi.mock("../../routes/webhooks/github/github-workspace-tip.js", () => ({
  getGithubRepoWriteView: vi.fn(),
  resolveWorkspaceRepositoryTip: vi.fn(),
}))

vi.mock("../enqueue-workspace-cutover.js", () => ({
  enqueueWorkspaceCutover: enqueueWorkspaceCutoverMock,
}))

vi.mock("../enqueue-workspace-hydrate.js", () => ({
  enqueueWorkspaceHydrate: enqueueWorkspaceHydrateMock,
}))

vi.mock("../enqueue-workspace-index.js", () => ({
  enqueueWorkspaceIndex: enqueueWorkspaceIndexMock,
}))

vi.mock("../enqueue-workspace-write-commit.js", () => ({
  enqueueWorkspaceWriteCommit: vi.fn(),
}))

vi.mock("openworkflow", () => ({
  defineWorkflow: (
    _opts: unknown,
    handler: (args: { input: { orgId: string } }) => Promise<unknown>,
  ) => ({
    fn: handler,
    spec: { name: "workspace-tip-check" },
  }),
}))

import { workspaceTipCheck } from "./workspace-tip-check.js"

const tipCheckFn = workspaceTipCheck as unknown as {
  fn: (args: { input: { orgId: string } }) => Promise<{
    updated: number
    linkedUpdated: number
  }>
}

describe("workspaceTipCheck workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listOrgWorkspacesMock.mockResolvedValue([])
    listMigrationExportShasMock.mockResolvedValue(new Map())
    listOrgLinkedRepositoriesMock.mockResolvedValue([])
    enqueueWorkspaceCutoverMock.mockResolvedValue(undefined)
  })

  it("completes sandbox GC without a Hono request", async () => {
    await expect(
      tipCheckFn.fn({ input: { orgId: "org_1" } }),
    ).resolves.toEqual({
      updated: 0,
      linkedUpdated: 0,
    })
  })
})
