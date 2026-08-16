import { describe, expect, it } from "vitest"
import {
  advisorWorkspaceId,
  CHAT_PERMISSION_MODE,
  CHAT_SANDBOX_LIMITS,
  chatSandboxAllowsRemotePush,
  createWorkspaceChatPermissionHandler,
  decideChatPermission,
  decideChatToolPermission,
  isMcpOriginConversation,
} from "./chat-sandbox-policy.js"

describe("chat sandbox policy", () => {
  it("does not use bypassPermissions", () => {
    expect(CHAT_PERMISSION_MODE).toBe("acceptEdits")
    expect(CHAT_SANDBOX_LIMITS).toMatchObject({
      vcpu: 1,
      memoryMib: 1024,
      pids: 128,
      diskGib: 4,
      privileged: false,
    })
  })

  it("never offers commit/push while the Workspace is read-only", () => {
    expect(chatSandboxAllowsRemotePush("read_only")).toBe(false)
    expect(chatSandboxAllowsRemotePush("unknown")).toBe(false)
    expect(chatSandboxAllowsRemotePush("writable")).toBe(true)
  })

  it("lets the judge allow only after hard denies and acceptEdits", () => {
    expect(
      decideChatPermission({
        hardDeny: "commit_push",
        acceptEditsWouldAllow: false,
        judge: "allow",
      }),
    ).toBe("deny")
    expect(
      decideChatPermission({
        acceptEditsWouldAllow: true,
        judge: "deny",
      }),
    ).toBe("allow")
    expect(
      decideChatPermission({
        acceptEditsWouldAllow: false,
        judge: "timeout",
      }),
    ).toBe("deny")
    expect(
      decideChatPermission({
        acceptEditsWouldAllow: false,
        judge: "allow",
      }),
    ).toBe("allow")
  })
})

describe("advisorWorkspaceId", () => {
  it("uses the persisted first Workspace, else created_at then id", () => {
    const rows = [
      { id: "ws_b", createdAt: new Date("2026-08-16T00:00:00.000Z") },
      { id: "ws_a", createdAt: new Date("2026-08-15T00:00:00.000Z") },
    ]
    expect(advisorWorkspaceId("ws_b", rows)).toBe("ws_b")
    expect(advisorWorkspaceId("ws_missing", rows)).toBe("ws_a")
    expect(advisorWorkspaceId(null, [])).toBeNull()
  })
})

describe("createWorkspaceChatPermissionHandler", () => {
  it("denies hard cases before the judge runs", async () => {
    const judge = async () => "allow" as const
    const handler = createWorkspaceChatPermissionHandler({
      writeStatus: "writable",
      judge,
    })
    await expect(handler({ toolName: "git_push" })).resolves.toBe("deny")
    await expect(handler({ toolName: "read_file" })).resolves.toBe("allow")
  })
})

describe("decideChatToolPermission", () => {
  it("hard-denies commit/push even when the judge would allow", () => {
    expect(
      decideChatToolPermission({
        toolName: "git_push",
        writeStatus: "writable",
        judge: "allow",
      }),
    ).toBe("deny")
    expect(
      decideChatToolPermission({
        toolName: "apply_patch",
        writeStatus: "read_only",
      }),
    ).toBe("allow")
  })
})

describe("isMcpOriginConversation", () => {
  it("marks MCP-origin threads so the UI list can exclude them", () => {
    expect(isMcpOriginConversation("mcp")).toBe(true)
    expect(isMcpOriginConversation("ui")).toBe(false)
  })
})
