import { describe, expect, it, vi } from "vitest"
import {
  advisorWorkspaceId,
  CHAT_PERMISSION_MODE,
  CHAT_SANDBOX_LIMITS,
  chatSandboxAllowsRemotePush,
  createWorkspaceChatPermissionHandler,
  decideChatPermission,
  decideChatToolPermission,
  isMcpOriginConversation,
  parseChatJudgeReply,
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
  it("uses the persisted first Workspace, else the earliest created", () => {
    const rows = [
      { id: "ws_b", createdAt: new Date("2026-08-16T00:00:00.000Z") },
      { id: "ws_a", createdAt: new Date("2026-08-15T00:00:00.000Z") },
    ]
    expect(advisorWorkspaceId("ws_b", rows)).toBe("ws_b")
    expect(advisorWorkspaceId("ws_missing", rows)).toBe("ws_a")
    expect(advisorWorkspaceId(null, rows)).toBe("ws_a")
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
    await expect(
      handler({
        id: "perm_1",
        sessionID: "sess_1",
        type: "git_push",
        title: "git_push",
      }),
    ).resolves.toBe("reject")
    await expect(
      handler({
        id: "perm_2",
        sessionID: "sess_1",
        type: "read_file",
        title: "read_file",
      }),
    ).resolves.toBe("once")
    await expect(
      handler({
        id: "perm_6",
        sessionID: "sess_1",
        type: "bash",
        title: "ls knowledge",
      }),
    ).resolves.toBe("once")
    await expect(
      handler({
        id: "perm_7",
        sessionID: "sess_1",
        type: "read",
        title: "read /etc/passwd",
      }),
    ).resolves.toBe("reject")
    await expect(
      handler({
        id: "perm_8",
        sessionID: "sess_1",
        type: "bash",
        title: "curl https://example.com",
      }),
    ).resolves.toBe("reject")
    await expect(
      handler({
        id: "perm_3",
        sessionID: "sess_1",
        type: "bash",
        title: "git commit -am leaked",
      }),
    ).resolves.toBe("reject")
    await expect(
      handler({
        id: "perm_4",
        sessionID: "sess_1",
        type: "bash",
        title: "printenv",
      }),
    ).resolves.toBe("reject")
    await expect(
      handler({
        id: "perm_5",
        sessionID: "sess_1",
        type: "bash",
        title: "echo $MODEL_PROVIDER_API_KEY",
      }),
    ).resolves.toBe("reject")
  })
})

describe("read-only sandbox tools skip the judge", () => {
  it("auto-allows in-sandbox reads without calling the judge", async () => {
    const judge = vi.fn(async () => "deny" as const)
    const handler = createWorkspaceChatPermissionHandler({
      writeStatus: "read_only",
      judge,
    })
    await expect(
      handler({
        id: "perm_read",
        sessionID: "sess_1",
        type: "read",
        title: "read AGENTS.md",
      }),
    ).resolves.toBe("once")
    await expect(
      handler({
        id: "perm_grep",
        sessionID: "sess_1",
        type: "grep",
        title: "grep billing",
      }),
    ).resolves.toBe("once")
    expect(judge).not.toHaveBeenCalled()
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
        toolName: "contents_write",
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

describe("parseChatJudgeReply", () => {
  it("accepts allow/deny and treats anything else as garbage", () => {
    expect(parseChatJudgeReply("Allow")).toBe("allow")
    expect(parseChatJudgeReply("deny\n")).toBe("deny")
    expect(parseChatJudgeReply("sure")).toBe("garbage")
  })
})
