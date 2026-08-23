import { beforeEach, describe, expect, it, vi } from "vitest"

const getSandboxInstance = vi.hoisted(() => vi.fn())
const persistSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const deleteSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const getWorkspaceById = vi.hoisted(() =>
  vi.fn(async (): Promise<{ id: string } | null> => ({ id: "ws_1" })),
)
const findConversationInWorkspace = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ id: string; workspaceId: string } | null> => ({
      id: "conv_1",
      workspaceId: "ws_1",
    }),
  ),
)
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string, fn: () => Promise<unknown>) => fn()),
)

vi.mock("../../models/workspaces.js", () => ({
  getSandboxInstance,
  persistSandboxInstance,
  deleteSandboxInstance,
  getWorkspaceById,
}))

vi.mock("../../models/conversations.js", () => ({
  findConversationInWorkspace,
}))

vi.mock("../../db/client.js", () => ({
  tryGetOrgDb: () => ({}),
  tryGetOrgDbOrgId: () => "org_test",
  assertNotInOrgDbContext: () => undefined,
  withOrgDbContext: withOrgDbContextMock,
}))

import {
  postgresSandboxInstanceStore,
  postgresSandboxLockStore,
} from "./sandbox-instance-store.js"

describe("postgresSandboxInstanceStore", () => {
  const store = postgresSandboxInstanceStore({
    orgId: "org_1",
    workspaceId: "ws_1",
  })

  beforeEach(() => {
    getSandboxInstance.mockReset()
    persistSandboxInstance.mockClear()
    deleteSandboxInstance.mockClear()
  })

  it("returns null when the key is missing or has no provider id", async () => {
    getSandboxInstance.mockResolvedValueOnce(null)
    await expect(store.get("missing")).resolves.toBeNull()
    getSandboxInstance.mockResolvedValueOnce({
      id: "key-1",
      kind: "chat",
      orgId: "org_1",
      workspaceId: "ws_1",
      state: "live",
      lastHeartbeatAt: new Date(),
    })
    await expect(store.get("key-1")).resolves.toBeNull()
  })

  it("maps a live row onto the TanStack instance record", async () => {
    const at = new Date("2026-08-17T12:00:00.000Z")
    getSandboxInstance.mockResolvedValueOnce({
      id: "key-1",
      kind: "chat",
      orgId: "org_1",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      provider: "docker",
      providerSandboxId: "sbx_live",
      latestSnapshotId: "snap_1",
      latestRunId: "run_1",
      state: "live",
      lastHeartbeatAt: at,
    })
    await expect(store.get("key-1")).resolves.toEqual({
      key: "key-1",
      provider: "docker",
      providerSandboxId: "sbx_live",
      threadId: "conv_1",
      latestSnapshotId: "snap_1",
      latestRunId: "run_1",
      updatedAt: at.getTime(),
    })
  })

  it("full-replaces optional snapshot fields on upsert", async () => {
    await store.upsert({
      key: "key-1",
      provider: "docker",
      providerSandboxId: "sbx_live",
      threadId: "conv_1",
      updatedAt: 1,
    })
    expect(persistSandboxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "conv_1",
        kind: "chat",
        orgId: "org_1",
        workspaceId: "ws_1",
        conversationId: "conv_1",
        provider: "docker",
        providerSandboxId: "sbx_live",
        latestSnapshotId: null,
        latestRunId: null,
      }),
    )
  })

  it("deletes a missing key without throwing", async () => {
    await expect(store.delete("missing")).resolves.toBeUndefined()
    expect(deleteSandboxInstance).toHaveBeenCalledWith("missing", "org_1")
  })
})

describe("postgresSandboxLockStore", () => {
  beforeEach(() => {
    getWorkspaceById.mockReset()
    getWorkspaceById.mockResolvedValue({ id: "ws_1" })
    findConversationInWorkspace.mockReset()
    findConversationInWorkspace.mockResolvedValue({
      id: "conv_1",
      workspaceId: "ws_1",
    })
    withOrgDbContextMock.mockReset()
    withOrgDbContextMock.mockImplementation(
      async (_orgId: string, fn: () => Promise<unknown>) => fn(),
    )
  })

  it("checks workspace existence in a short org tx then runs fn after commit", async () => {
    const order: string[] = []
    withOrgDbContextMock.mockImplementation(
      async (_orgId: string, fn: () => Promise<unknown>) => {
        order.push("org-tx")
        try {
          return await fn()
        } finally {
          order.push("org-commit")
        }
      },
    )
    getWorkspaceById.mockImplementation(async () => {
      order.push("workspace")
      return { id: "ws_1" }
    })
    const ran = vi.fn(async () => {
      order.push("fn")
      return "ok"
    })
    const locks = postgresSandboxLockStore({
      orgId: "org_1",
      workspaceId: "ws_1",
    })
    await expect(locks.withLock("sandbox:key", ran)).resolves.toBe("ok")
    expect(order).toEqual(["org-tx", "workspace", "org-commit", "fn"])
    expect(findConversationInWorkspace).not.toHaveBeenCalled()
  })

  it("refuses chat create after the Workspace row is gone", async () => {
    getWorkspaceById.mockResolvedValueOnce(null)
    const ran = vi.fn(async () => "ok")
    const locks = postgresSandboxLockStore({
      orgId: "org_1",
      workspaceId: "ws_1",
    })
    await expect(locks.withLock("sandbox:key", ran)).rejects.toThrow(
      /Workspace ws_1 is gone/,
    )
    expect(ran).not.toHaveBeenCalled()
  })

  it("checks conversation existence without a user-scoped lookup", async () => {
    const ran = vi.fn(async () => "ok")
    const locks = postgresSandboxLockStore({
      orgId: "org_1",
      workspaceId: "ws_1",
      conversationId: "conv_1",
    })
    await expect(locks.withLock("sandbox:key", ran)).resolves.toBe("ok")
    expect(findConversationInWorkspace).toHaveBeenCalledWith("conv_1", "ws_1")
    expect(ran).toHaveBeenCalledOnce()
  })

  it("refuses chat create after the conversation row is gone", async () => {
    findConversationInWorkspace.mockResolvedValueOnce(null)
    const ran = vi.fn(async () => "ok")
    const locks = postgresSandboxLockStore({
      orgId: "org_1",
      workspaceId: "ws_1",
      conversationId: "conv_1",
    })
    await expect(locks.withLock("sandbox:key", ran)).rejects.toThrow(
      /Conversation conv_1 is gone/,
    )
    expect(findConversationInWorkspace).toHaveBeenCalledWith("conv_1", "ws_1")
    expect(ran).not.toHaveBeenCalled()
  })
})
