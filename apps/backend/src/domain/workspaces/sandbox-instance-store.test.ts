import { beforeEach, describe, expect, it, vi } from "vitest"

const getSandboxInstance = vi.hoisted(() => vi.fn())
const persistSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const deleteSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("../../models/workspaces.js", () => ({
  getSandboxInstance,
  persistSandboxInstance,
  deleteSandboxInstance,
}))

import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"

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
      provider: "local-process",
      providerSandboxId: "sbx_live",
      latestSnapshotId: "snap_1",
      latestRunId: "run_1",
      state: "live",
      lastHeartbeatAt: at,
    })
    await expect(store.get("key-1")).resolves.toEqual({
      key: "key-1",
      provider: "local-process",
      providerSandboxId: "sbx_live",
      threadId: "conv_1",
      latestSnapshotId: "snap_1",
      latestRunId: "run_1",
      updatedAt: at.getTime(),
    })
  })

  it("persists TanStack's opaque key as the row id", async () => {
    await store.upsert({
      key: "thread:conv_1",
      provider: "local-process",
      providerSandboxId: "sbx_live",
      threadId: "conv_1",
      updatedAt: 1,
    })
    expect(persistSandboxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "thread:conv_1",
        kind: "chat",
        orgId: "org_1",
        workspaceId: "ws_1",
        conversationId: "conv_1",
        provider: "local-process",
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
