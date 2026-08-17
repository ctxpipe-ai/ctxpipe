import { beforeEach, describe, expect, it, vi } from "vitest"
import { CHAT_SANDBOX_IDLE_MS, JOB_SANDBOX_IDLE_MS } from "./chat-lifecycle.js"
import {
  attachChatSandboxHandle,
  attachWorkspaceSandbox,
  chatSandboxesDueForDestroy,
  destroySandboxesForConversation,
  destroySandboxesForWorkspace,
  destroyWorkspaceSandbox,
  getChatSandbox,
  getJobSandbox,
  getRegisteredChatSandbox,
  heartbeatChatSandboxes,
  jobSandboxesDueForDestroy,
  registerWorkspaceSandbox,
  resetRegisteredSandboxes,
} from "./sandbox-registry.js"

const claimSandboxInstance = vi.hoisted(() =>
  vi.fn(async (input: { id: string }) => ({
    record: input,
    inserted: true,
  })),
)
const listSandboxInstances = vi.hoisted(() => vi.fn(async () => []))
const deleteSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const persistSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const heartbeatSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const getSandboxInstance = vi.hoisted(() => vi.fn(async () => null))

vi.mock("../../models/workspaces.js", () => ({
  claimSandboxInstance,
  listSandboxInstances,
  deleteSandboxInstance,
  persistSandboxInstance,
  heartbeatSandboxInstance,
  getSandboxInstance,
}))

const handle = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  fs: {
    write: async () => undefined,
    read: async () => "",
    remove: async () => undefined,
    mkdir: async () => undefined,
  },
}

describe("sandbox registry GC", () => {
  beforeEach(() => {
    claimSandboxInstance.mockImplementation(async (input: { id: string }) => ({
      record: input,
      inserted: true,
    }))
    claimSandboxInstance.mockClear()
    listSandboxInstances.mockResolvedValue([])
    deleteSandboxInstance.mockClear()
    persistSandboxInstance.mockClear()
    heartbeatSandboxInstance.mockClear()
    getSandboxInstance.mockReset()
    getSandboxInstance.mockResolvedValue(null)
    resetRegisteredSandboxes()
  })

  it("destroys idle chat after 30 minutes and jobs after 60", () => {
    const now = new Date("2026-08-16T12:00:00.000Z")
    expect(
      chatSandboxesDueForDestroy({
        conversations: [
          {
            id: "conv_idle",
            lastMessageAt: new Date(now.getTime() - CHAT_SANDBOX_IDLE_MS),
          },
          { id: "conv_live", lastMessageAt: now },
        ],
        now,
      }),
    ).toEqual(["conv_idle"])
    expect(
      jobSandboxesDueForDestroy({
        workspaces: [
          {
            id: "ws_idle",
            lastJobAt: new Date(now.getTime() - JOB_SANDBOX_IDLE_MS),
          },
          { id: "ws_live", lastJobAt: now },
        ],
        now,
      }),
    ).toEqual(["ws_idle"])
  })

  it("returns the attached job sandbox handle for a Workspace", async () => {
    await registerWorkspaceSandbox({
      id: "job-ws_1",
      kind: "job",
      workspaceId: "ws_1",
      handle,
    })
    expect(getJobSandbox("ws_1")).toBe(handle)
    expect(getJobSandbox("ws_missing")).toBeNull()
  })

  it("returns captured chat metadata even before a handle is attached", () => {
    attachWorkspaceSandbox({
      id: "conv_meta",
      kind: "chat",
      workspaceId: "ws_1",
      conversationId: "conv_meta",
      desiredUrl: "https://github.com/acme/docs",
      desiredGeneration: 2,
      desiredSha: "abc",
      defaultBranch: "main",
    })
    expect(getRegisteredChatSandbox("conv_meta")).toMatchObject({
      desiredUrl: "https://github.com/acme/docs",
      desiredGeneration: 2,
      desiredSha: "abc",
      defaultBranch: "main",
    })
    expect(getChatSandbox("conv_meta")).toBeNull()
    expect(claimSandboxInstance).not.toHaveBeenCalled()
  })

  it("keeps the handle and marks destroy_failed when destroy throws", async () => {
    await registerWorkspaceSandbox({
      id: "chat-conv_fail",
      kind: "chat",
      workspaceId: "ws_1",
      conversationId: "conv_fail",
      handle,
      destroy: async () => {
        throw new Error("sandbox still running")
      },
    })
    await expect(destroyWorkspaceSandbox("chat-conv_fail")).resolves.toBe(false)
    expect(getChatSandbox("conv_fail")).toBe(handle)
    expect(persistSandboxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "chat-conv_fail",
        state: "destroy_failed",
      }),
    )
  })

  it("attaches the handle to the live id claimed from Postgres", async () => {
    claimSandboxInstance.mockResolvedValueOnce({
      record: {
        id: "job-live-from-store",
        kind: "job",
        workspaceId: "ws_claim",
        state: "live",
        lastHeartbeatAt: new Date("2026-08-17T00:00:00.000Z"),
      },
      inserted: false,
    })
    const registered = await registerWorkspaceSandbox({
      id: "job-preferred",
      kind: "job",
      workspaceId: "ws_claim",
      handle,
    })
    expect(registered.id).toBe("job-live-from-store")
    expect(getJobSandbox("ws_claim")).toBe(handle)
  })

  it("GCs chat and job rows from Postgres when this process has no handle", async () => {
    listSandboxInstances.mockImplementation(
      async (input: { conversationId?: string; workspaceId?: string }) => {
        if (input.conversationId === "conv_orphan") {
          return [
            {
              id: "chat-orphan",
              kind: "chat",
              workspaceId: "ws_orphan",
              conversationId: "conv_orphan",
              state: "live",
              lastHeartbeatAt: new Date(),
            },
          ]
        }
        if (input.workspaceId === "ws_orphan_job") {
          return [
            {
              id: "job-orphan",
              kind: "job",
              workspaceId: "ws_orphan_job",
              state: "live",
              lastHeartbeatAt: new Date(),
            },
          ]
        }
        return []
      },
    )
    await expect(destroySandboxesForConversation("conv_orphan")).resolves.toBe(
      1,
    )
    expect(deleteSandboxInstance).toHaveBeenCalledWith("chat-orphan", undefined)
    await expect(
      destroySandboxesForWorkspace("ws_orphan_job", "job"),
    ).resolves.toBe(1)
    expect(deleteSandboxInstance).toHaveBeenCalledWith("job-orphan", undefined)
  })

  it("heartbeats the TanStack store row for a conversation, not a synthetic live id", async () => {
    attachWorkspaceSandbox({
      id: "conv_hb",
      kind: "chat",
      orgId: "org_1",
      workspaceId: "ws_1",
      conversationId: "conv_hb",
    })
    listSandboxInstances.mockResolvedValueOnce([
      {
        id: "tanstack-key",
        kind: "chat",
        orgId: "org_1",
        workspaceId: "ws_1",
        conversationId: "conv_hb",
        providerSandboxId: "sbx_live",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
    ])
    const at = new Date("2026-08-17T12:00:00.000Z")
    heartbeatChatSandboxes("conv_hb", at)
    await vi.waitFor(() => {
      expect(heartbeatSandboxInstance).toHaveBeenCalledWith(
        "conv_hb",
        at,
        "org_1",
      )
      expect(heartbeatSandboxInstance).toHaveBeenCalledWith(
        "tanstack-key",
        at,
        "org_1",
      )
    })
  })

  it("binds the chat handle to the TanStack store key", async () => {
    listSandboxInstances.mockResolvedValueOnce([
      {
        id: "tanstack-key",
        kind: "chat",
        orgId: "org_1",
        workspaceId: "ws_1",
        conversationId: "conv_bind",
        provider: "docker",
        providerSandboxId: "sbx_live",
        latestSnapshotId: "snap_1",
        state: "live",
        lastHeartbeatAt: new Date(),
      },
    ])
    const attached = await attachChatSandboxHandle({
      kind: "chat",
      workspaceId: "ws_1",
      conversationId: "conv_bind",
      orgId: "org_1",
      handle,
      destroy: async () => undefined,
    })
    expect(attached.id).toBe("tanstack-key")
    expect(attached.providerSandboxId).toBe("sbx_live")
    expect(getRegisteredChatSandbox("conv_bind")?.id).toBe("tanstack-key")
    expect(getChatSandbox("conv_bind")).toBe(handle)
  })

  it("keeps the resume row when destroy fails on a differently keyed handle", async () => {
    attachWorkspaceSandbox({
      id: "conv_mismatch",
      kind: "chat",
      orgId: "org_1",
      workspaceId: "ws_1",
      conversationId: "conv_mismatch",
      handle,
      destroy: async () => {
        throw new Error("sandbox still running")
      },
    })
    const stored = {
      id: "tanstack-key",
      kind: "chat" as const,
      orgId: "org_1",
      workspaceId: "ws_1",
      conversationId: "conv_mismatch",
      provider: "docker",
      providerSandboxId: "sbx_live",
      latestSnapshotId: "snap_1",
      state: "live" as const,
      lastHeartbeatAt: new Date(),
    }
    listSandboxInstances.mockResolvedValue([stored])
    getSandboxInstance.mockImplementation(async (id: string) =>
      id === "tanstack-key" ? stored : null,
    )
    await expect(
      destroySandboxesForConversation("conv_mismatch"),
    ).resolves.toBe(0)
    expect(deleteSandboxInstance).not.toHaveBeenCalledWith(
      "tanstack-key",
      expect.anything(),
    )
    expect(persistSandboxInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tanstack-key",
        state: "destroy_failed",
        providerSandboxId: "sbx_live",
        latestSnapshotId: "snap_1",
      }),
    )
    expect(getChatSandbox("conv_mismatch")).toBe(handle)
  })
})
