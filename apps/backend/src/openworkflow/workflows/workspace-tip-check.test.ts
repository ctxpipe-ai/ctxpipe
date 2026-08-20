import { beforeEach, describe, expect, it, vi } from "vitest"

const listOrgWorkspacesMock = vi.hoisted(() => vi.fn())
const listMigrationExportShasMock = vi.hoisted(() => vi.fn())
const listOrgLinkedRepositoriesMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceHydrateMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceIndexMock = vi.hoisted(() => vi.fn())
const enqueueWorkspaceWriteCommitMock = vi.hoisted(() => vi.fn())
const getGithubRepoWriteViewMock = vi.hoisted(() => vi.fn())
const probeInTx = vi.hoisted(() => ({ value: false, seen: false }))
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
  getGithubRepoWriteView: (...args: unknown[]) => {
    probeInTx.seen = true
    probeInTx.value = orgTxDepth.value > 0
    return getGithubRepoWriteViewMock(...args)
  },
  resolveWorkspaceRepositoryTip: vi.fn(),
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
    probeInTx.seen = false
    probeInTx.value = false
    enqueueInTx.seen = false
    enqueueInTx.value = false
    listOrgWorkspacesMock.mockResolvedValue([])
    listMigrationExportShasMock.mockResolvedValue(new Map())
    listOrgLinkedRepositoriesMock.mockResolvedValue([])
    getGithubRepoWriteViewMock.mockResolvedValue({
      canPush: true,
      defaultBranch: "main",
    })
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

  it("probes GitHub and enqueues write-commit outside the org SQL transaction", async () => {
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
    expect(probeInTx.seen).toBe(true)
    expect(probeInTx.value).toBe(false)
    expect(enqueueInTx.seen).toBe(true)
    expect(enqueueInTx.value).toBe(false)
  })
})
