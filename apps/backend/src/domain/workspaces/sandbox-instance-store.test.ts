import { beforeEach, describe, expect, it, vi } from "vitest"

const getSandboxInstance = vi.hoisted(() => vi.fn())
const persistSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const deleteSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const getWorkspaceById = vi.hoisted(() => vi.fn(async () => ({ id: "ws_1" })))
const withDbClientMock = vi.hoisted(() => vi.fn())
const withOrgDbContextMock = vi.hoisted(() =>
  vi.fn(async (_orgId: string, fn: () => Promise<unknown>) => fn()),
)

vi.mock("../../models/workspaces.js", () => ({
  getSandboxInstance,
  persistSandboxInstance,
  deleteSandboxInstance,
  getWorkspaceById,
}))

vi.mock("../../db/client.js", () => ({
  withLockClient: withDbClientMock,
  withOrgDbContext: withOrgDbContextMock,
}))

import {
  postgresSandboxInstanceStore,
  postgresSandboxLockStore,
  withSandboxAdvisoryLock,
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
        id: "key-1",
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
  })

  it("takes the workspace lock then the instance lock without a transaction", async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    withDbClientMock.mockImplementation(
      async (fn: (client: { query: typeof query }) => unknown) => fn({ query }),
    )
    const ran = vi.fn(async () => "ok")
    const locks = postgresSandboxLockStore({
      orgId: "org_1",
      workspaceId: "ws_1",
    })
    await expect(locks.withLock("sandbox:key", ran)).resolves.toBe("ok")
    const locked = query.mock.calls
      .filter((call) => String(call[0]).includes("pg_advisory_lock("))
      .map((call) => call[1]?.[0])
    expect(locked).toEqual(["sandbox:job:ws_1", "sandbox:key"])
    expect(query.mock.calls[0]?.[0]).not.toMatch(/xact/)
    expect(query.mock.calls.at(-1)?.[0]).toMatch(/pg_advisory_unlock/)
    expect(ran).toHaveBeenCalled()
  })

  it("does not take a second connection for a nested workspace lock", async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    withDbClientMock.mockImplementation(
      async (fn: (client: { query: typeof query }) => unknown) => fn({ query }),
    )
    await withSandboxAdvisoryLock("sandbox:job:ws_1", async () =>
      withSandboxAdvisoryLock("sandbox:job:ws_1", async () => "ok"),
    )
    const locked = query.mock.calls.filter((call) =>
      String(call[0]).includes("pg_advisory_lock("),
    )
    expect(locked).toHaveLength(1)
  })

  it("unlocks when the critical section throws", async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    withDbClientMock.mockImplementation(
      async (fn: (client: { query: typeof query }) => unknown) => fn({ query }),
    )
    await expect(
      withSandboxAdvisoryLock("sandbox:key", async () => {
        throw new Error("create failed")
      }),
    ).rejects.toThrow("create failed")
    expect(query.mock.calls.at(-1)?.[0]).toMatch(/pg_advisory_unlock/)
  })

  it("refuses chat create after the Workspace row is gone", async () => {
    const query = vi.fn().mockResolvedValue(undefined)
    withDbClientMock.mockImplementation(
      async (fn: (client: { query: typeof query }) => unknown) => fn({ query }),
    )
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
})
