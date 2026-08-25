import { beforeEach, describe, expect, it, vi } from "vitest"

const listOrgWorkspacesMock = vi.hoisted(() => vi.fn())
const listMigrationExportShasMock = vi.hoisted(() => vi.fn())
const listOrgLinkedRepositoriesMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceHydrateMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceIndexMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceWriteCommitMock = vi.hoisted(() => vi.fn())
const enqueueInTx = vi.hoisted(() => ({ value: false, seen: false }))
const orgTxDepth = vi.hoisted(() => ({ value: 0 }))

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
  withOrgDbContext: async (_orgId: string, fn: () => unknown) => {
    orgTxDepth.value += 1
    try {
      return await fn()
    } finally {
      orgTxDepth.value -= 1
    }
  },
  assertNotInOrgDbContext: () => undefined,
  tryGetOrgDb: () => (orgTxDepth.value > 0 ? {} : undefined),
  getOrgDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
  }),
}))

vi.mock("../../auth/withAuth.js", () => ({
  withOrgIdContext: (_org: unknown, fn: () => unknown) => fn(),
}))

vi.mock("../../models/conversations.js", () => ({
  listOrgConversationsForSandboxGc: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../models/workspaces.js", () => ({
  listOrgWorkspaces: listOrgWorkspacesMock,
  listMigrationExportShas: listMigrationExportShasMock,
  listMigrationExportJobWorkspaceIds: vi.fn().mockResolvedValue(new Set()),
  reconcileDestWorkspaceAssignment: vi.fn().mockResolvedValue({
    firstWorkspaceId: null,
    firstSourceRepositoryId: null,
  }),
  listOrgLinkedRepositories: listOrgLinkedRepositoriesMock,
  listPausedWriteJobs: vi.fn().mockResolvedValue([
    {
      id: "wjob_paused",
      kind: "migration_export",
      generation: 1,
      desiredSha: "abc",
      status: "paused",
      payload: {
        jobWorkspaceUrl: "https://github.com/acme/app.git",
      },
    },
  ]),
  claimPausedWriteJob: vi.fn().mockResolvedValue(true),
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
  resolveWorkspaceRepositoryTip: vi.fn(),
  getGithubRepoWriteView: vi.fn().mockResolvedValue({
    defaultBranch: "main",
    canPush: true,
  }),
}))

vi.mock("../enqueue-workspace-hydrate.js", () => ({
  enqueueWorkspaceHydrate: enqueueWorkspaceHydrateMock,
}))

vi.mock("../enqueue-workspace-index.js", () => ({
  enqueueWorkspaceIndex: enqueueWorkspaceIndexMock,
}))

vi.mock("../enqueue-workspace-write-commit.js", () => ({
  enqueueWorkspaceWriteCommit: (...args: unknown[]) => {
    enqueueInTx.seen = true
    enqueueInTx.value = orgTxDepth.value > 0
    return enqueueWorkspaceWriteCommitMock(...args)
  },
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
    orgTxDepth.value = 0
    enqueueInTx.seen = false
    enqueueInTx.value = false
    listOrgWorkspacesMock.mockResolvedValue([])
    listMigrationExportShasMock.mockResolvedValue(new Map())
    listOrgLinkedRepositoriesMock.mockResolvedValue([])
    enqueueWorkspaceWriteCommitMock.mockResolvedValue({ started: true })
  })

  it("completes sandbox GC without a Hono request", async () => {
    await expect(tipCheckFn.fn({ input: { orgId: "org_1" } })).resolves.toEqual(
      {
        updated: 0,
        linkedUpdated: 0,
      },
    )
  })

  it("enqueues write-commit outside the org SQL transaction", async () => {
    listOrgWorkspacesMock.mockResolvedValue([
      {
        id: "ws_1",
        workspaceRepositoryUrl: "https://github.com/acme/app.git",
        desiredGeneration: 1,
        desiredSha: "abc",
        activeProjectionSha: "abc",
        githubConnectionId: "con_gh",
        createdAt: new Date(),
        lastJobAt: null,
      },
    ])
    await tipCheckFn.fn({ input: { orgId: "org_1" } })
    expect(enqueueInTx.seen).toBe(true)
    expect(enqueueInTx.value).toBe(false)
  })

  it("enqueues a missing migration_export for a writable workspace without an export job", async () => {
    listOrgWorkspacesMock.mockResolvedValue([
      {
        id: "ws_backfill",
        workspaceRepositoryUrl: "https://github.com/acme/docs.git",
        desiredGeneration: 1,
        desiredSha: "abc",
        activeProjectionSha: "abc",
        githubConnectionId: "con_gh",
        createdAt: new Date(),
        lastJobAt: null,
      },
    ])
    listMigrationExportShasMock.mockResolvedValue(new Map())
    await tipCheckFn.fn({ input: { orgId: "org_1" } })
    expect(enqueueWorkspaceWriteCommitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        workspaceId: "ws_backfill",
        kind: "migration_export",
      }),
      expect.anything(),
    )
  })
})
