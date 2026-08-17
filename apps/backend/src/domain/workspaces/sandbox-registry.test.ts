import { describe, expect, it, vi } from "vitest"
import { CHAT_SANDBOX_IDLE_MS, JOB_SANDBOX_IDLE_MS } from "./chat-lifecycle.js"
import {
  chatSandboxesDueForDestroy,
  destroyWorkspaceSandbox,
  getChatSandbox,
  getJobSandbox,
  getRegisteredChatSandbox,
  jobSandboxesDueForDestroy,
  registerWorkspaceSandbox,
} from "./sandbox-registry.js"

vi.mock("../../models/workspaces.js", () => ({
  persistSandboxInstance: vi.fn(async () => {}),
  deleteSandboxInstance: vi.fn(async () => {}),
}))

describe("sandbox registry GC", () => {
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

  it("returns the attached job sandbox handle for a Workspace", () => {
    const handle = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
    }
    registerWorkspaceSandbox({
      id: "job-ws_1",
      kind: "job",
      workspaceId: "ws_1",
      handle,
    })
    expect(getJobSandbox("ws_1")).toBe(handle)
    expect(getJobSandbox("ws_missing")).toBeNull()
  })

  it("returns captured chat metadata even before a handle is attached", () => {
    registerWorkspaceSandbox({
      id: "chat-conv_meta",
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
  })

  it("keeps the handle and marks destroy_failed when destroy throws", async () => {
    const handle = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      fs: {
        write: async () => undefined,
        read: async () => "",
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
    }
    registerWorkspaceSandbox({
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
  })
})
