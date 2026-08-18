import { beforeEach, describe, expect, it, vi } from "vitest"

const enqueueWorkspaceWriteCommitMock = vi.hoisted(() => vi.fn())
const persistHydrateFailureMock = vi.hoisted(() => vi.fn())
const listConnectorTargetRepositoriesMock = vi.hoisted(() => vi.fn())
const listOrgWorkspacesMock = vi.hoisted(() => vi.fn())
const getPersistedFirstWorkspaceIdMock = vi.hoisted(() => vi.fn())
const listCompletedMigrationExportWorkspaceIdsMock = vi.hoisted(() => vi.fn())

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

vi.mock("../../models/connector-sync-target.js", () => ({
  listConnectorTargetRepositories: listConnectorTargetRepositoriesMock,
}))

vi.mock("../../models/workspaces.js", () => ({
  createCutoverWorkspace: vi.fn(),
  getPersistedFirstWorkspaceId: getPersistedFirstWorkspaceIdMock,
  listCompletedMigrationExportWorkspaceIds:
    listCompletedMigrationExportWorkspaceIdsMock,
  listOrgWorkspaces: listOrgWorkspacesMock,
  persistFirstWorkspaceId: vi.fn(),
  persistHydrateFailure: persistHydrateFailureMock,
}))

vi.mock("../enqueue-workspace-write-commit.js", () => ({
  enqueueWorkspaceWriteCommit: enqueueWorkspaceWriteCommitMock,
}))

vi.mock("openworkflow", () => ({
  defineWorkflow: (
    _opts: unknown,
    handler: (args: { input: { orgId: string } }) => Promise<unknown>,
  ) => ({
    fn: handler,
    spec: { name: "workspace-cutover" },
  }),
}))

import { workspaceCutover } from "./workspace-cutover.js"

const cutoverFn = workspaceCutover as unknown as {
  fn: (args: { input: { orgId: string } }) => Promise<{
    created: number
    exports: number
  }>
}

describe("workspaceCutover workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listConnectorTargetRepositoriesMock.mockResolvedValue([
      { gitUrl: "https://github.com/acme/docs", name: "docs" },
    ])
    listOrgWorkspacesMock.mockResolvedValue([
      {
        id: "ws_1",
        workspaceRepositoryUrl: "https://github.com/acme/docs",
      },
    ])
    getPersistedFirstWorkspaceIdMock.mockResolvedValue("ws_1")
    listCompletedMigrationExportWorkspaceIdsMock.mockResolvedValue([])
    enqueueWorkspaceWriteCommitMock.mockResolvedValue({ started: true })
    persistHydrateFailureMock.mockResolvedValue(undefined)
  })

  it("does not finish until migration export enqueue settles", async () => {
    let settleEnqueue: (() => void) | undefined
    enqueueWorkspaceWriteCommitMock.mockImplementation(
      () =>
        new Promise<{ started: boolean }>((resolve) => {
          settleEnqueue = () => resolve({ started: true })
        }),
    )
    const pending = cutoverFn.fn({ input: { orgId: "org_1" } })
    let finished = false
    void pending.then(() => {
      finished = true
    })
    await vi.waitFor(() => {
      expect(enqueueWorkspaceWriteCommitMock).toHaveBeenCalled()
    })
    expect(finished).toBe(false)
    settleEnqueue?.()
    await expect(pending).resolves.toEqual({ created: 0, exports: 1 })
  })

  it("does not count a migration export that did not start", async () => {
    enqueueWorkspaceWriteCommitMock.mockResolvedValue({ started: false })
    await expect(
      cutoverFn.fn({ input: { orgId: "org_1" } }),
    ).resolves.toEqual({ created: 0, exports: 0 })
  })

  it("persists hydrate failure when export enqueue throws", async () => {
    enqueueWorkspaceWriteCommitMock.mockRejectedValue(new Error("queue down"))
    await expect(
      cutoverFn.fn({ input: { orgId: "org_1" } }),
    ).resolves.toEqual({ created: 0, exports: 0 })
    expect(persistHydrateFailureMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      message: "queue down",
    })
  })
})
