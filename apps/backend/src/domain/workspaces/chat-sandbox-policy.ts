import type { PermissionHandler } from "@tanstack/ai-opencode"

export const CHAT_PERMISSION_MODE = "acceptEdits" as const

export const CHAT_SANDBOX_LIMITS = {
  vcpu: 1,
  memoryMib: 1024,
  pids: 128,
  diskGib: 4,
  nonRoot: true,
  privileged: false,
} as const

export const CHAT_HARD_DENY_REASONS = [
  "app_pem",
  "auth_secret",
  "contents_write",
  "commit_push",
  "cloud_metadata",
  "host_not_allowlisted",
] as const

export type ChatHardDenyReason = (typeof CHAT_HARD_DENY_REASONS)[number]

export function chatSandboxAllowsRemotePush(writeStatus: string): boolean {
  return writeStatus === "writable"
}

export function isChatHardDeny(reason: string): reason is ChatHardDenyReason {
  return (CHAT_HARD_DENY_REASONS as readonly string[]).includes(reason)
}

/** Judge cannot override a hard deny. Timeout/garbage also deny. */
export function decideChatPermission(input: {
  hardDeny?: ChatHardDenyReason | null
  acceptEditsWouldAllow: boolean
  judge?: "allow" | "deny" | "timeout" | "garbage"
}): "allow" | "deny" {
  if (input.hardDeny) return "deny"
  if (input.acceptEditsWouldAllow) return "allow"
  if (input.judge === "allow") return "allow"
  return "deny"
}

export function advisorWorkspaceId<T extends { createdAt: Date; id: string }>(
  persistedFirstWorkspaceId: string | null,
  workspaces: readonly T[],
): string | null {
  if (
    persistedFirstWorkspaceId &&
    workspaces.some((row) => row.id === persistedFirstWorkspaceId)
  ) {
    return persistedFirstWorkspaceId
  }
  return null
}

export function isMcpOriginConversation(
  origin: string | null | undefined,
): boolean {
  return origin === "mcp"
}

export function classifyChatToolRequest(input: {
  toolName: string
  argsExcerpt?: string
  writeStatus: string
}): {
  hardDeny: ChatHardDenyReason | null
  acceptEditsWouldAllow: boolean
} {
  const name = input.toolName.toLowerCase()
  const excerpt = (input.argsExcerpt ?? "").toLowerCase()
  if (
    name.includes("app_pem") ||
    excerpt.includes("app.pem") ||
    excerpt.includes("private_key")
  ) {
    return { hardDeny: "app_pem", acceptEditsWouldAllow: false }
  }
  if (name.includes("auth_secret") || excerpt.includes("auth_secret")) {
    return { hardDeny: "auth_secret", acceptEditsWouldAllow: false }
  }
  if (
    excerpt.includes("169.254.169.254") ||
    excerpt.includes("metadata.google.internal")
  ) {
    return { hardDeny: "cloud_metadata", acceptEditsWouldAllow: false }
  }
  if (
    name.includes("commit") ||
    name.includes("git_push") ||
    name === "push" ||
    excerpt.includes("git push")
  ) {
    return { hardDeny: "commit_push", acceptEditsWouldAllow: false }
  }
  if (
    !chatSandboxAllowsRemotePush(input.writeStatus) &&
    (name.includes("contents_write") || excerpt.includes("contents:write"))
  ) {
    return { hardDeny: "contents_write", acceptEditsWouldAllow: false }
  }
  if (
    name.includes("edit") ||
    name.includes("write") ||
    name.includes("apply_patch")
  ) {
    return { hardDeny: null, acceptEditsWouldAllow: true }
  }
  return { hardDeny: null, acceptEditsWouldAllow: false }
}

export function createWorkspaceChatPermissionHandler(input: {
  writeStatus: string
  judge?: (
    toolName: string,
    argsExcerpt: string,
  ) => Promise<"allow" | "deny" | "timeout" | "garbage">
}): PermissionHandler {
  return async (request) => {
    const toolName = request.type || request.title
    const argsExcerpt = request.title
    const classified = classifyChatToolRequest({
      toolName,
      argsExcerpt,
      writeStatus: input.writeStatus,
    })
    if (classified.hardDeny) return "reject"
    if (classified.acceptEditsWouldAllow) return "once"
    const judge = input.judge
      ? await input.judge(toolName, argsExcerpt)
      : "deny"
    return decideChatPermission({ ...classified, judge }) === "allow"
      ? "once"
      : "reject"
  }
}

export function decideChatToolPermission(input: {
  toolName: string
  argsExcerpt?: string
  writeStatus: string
  judge?: "allow" | "deny" | "timeout" | "garbage"
}): "allow" | "deny" {
  const classified = classifyChatToolRequest(input)
  return decideChatPermission({
    ...classified,
    judge: input.judge,
  })
}
