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
  if (workspaces.length === 0) return null
  return (
    [...workspaces].sort((a, b) => {
      const byTime = a.createdAt.getTime() - b.createdAt.getTime()
      if (byTime !== 0) return byTime
      if (a.id < b.id) return -1
      if (a.id > b.id) return 1
      return 0
    })[0]?.id ?? null
  )
}

export function isMcpOriginConversation(
  origin: string | null | undefined,
): boolean {
  return origin === "mcp"
}
