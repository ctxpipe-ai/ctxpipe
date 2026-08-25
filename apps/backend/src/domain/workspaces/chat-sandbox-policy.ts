import type { PermissionHandler } from "@tanstack/ai-opencode"

import { firstConnectorTarget } from "./dest-workspace-first.js"

export const CHAT_PERMISSION_MODE = "acceptEdits" as const

export const CHAT_HARD_DENY_REASONS = [
  "app_pem",
  "auth_secret",
  "contents_write",
  "commit_push",
  "cloud_metadata",
  "host_not_allowlisted",
  "printenv",
  "key_exfil",
  "sensitive_path",
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
  return firstConnectorTarget(workspaces)?.id ?? null
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
  void input.writeStatus
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
    name.includes("printenv") ||
    excerpt.includes("printenv") ||
    excerpt.includes("env |") ||
    excerpt.includes("export -p")
  ) {
    return { hardDeny: "printenv", acceptEditsWouldAllow: false }
  }
  if (
    excerpt.includes("model_provider_api_key") ||
    excerpt.includes("openai_api_key") ||
    excerpt.includes("anthropic_api_key") ||
    excerpt.includes("openrouter_api_key") ||
    excerpt.includes("database_url")
  ) {
    return { hardDeny: "key_exfil", acceptEditsWouldAllow: false }
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
    excerpt.includes("git push") ||
    excerpt.includes("git commit")
  ) {
    return { hardDeny: "commit_push", acceptEditsWouldAllow: false }
  }
  if (name.includes("contents_write") || excerpt.includes("contents:write")) {
    return { hardDeny: "contents_write", acceptEditsWouldAllow: false }
  }
  if (excerptLooksLikeSensitivePath(excerpt)) {
    return { hardDeny: "sensitive_path", acceptEditsWouldAllow: false }
  }
  if (excerptLooksLikeEgress(excerpt)) {
    return { hardDeny: "host_not_allowlisted", acceptEditsWouldAllow: false }
  }
  if (
    name.includes("edit") ||
    name.includes("write") ||
    name.includes("apply_patch")
  ) {
    return { hardDeny: null, acceptEditsWouldAllow: true }
  }
  if (isReadOnlySandboxTool(name, excerpt)) {
    return { hardDeny: null, acceptEditsWouldAllow: true }
  }
  return { hardDeny: null, acceptEditsWouldAllow: false }
}

function excerptLooksLikeSensitivePath(excerpt: string): boolean {
  return (
    excerpt.includes("/etc/passwd") ||
    excerpt.includes("/proc/") ||
    excerpt.includes("/sys/") ||
    excerpt.includes("/dev/") ||
    excerpt.includes("/root/") ||
    /(?:^|[\s"'`=])\/etc\/passwd/.test(excerpt)
  )
}

function excerptLooksLikeEgress(excerpt: string): boolean {
  if (!/\b(curl|wget|ncat|nc|ssh|scp)\b/.test(excerpt)) return false
  return !/\b(127\.0\.0\.1|localhost|::1)\b/.test(excerpt)
}

function excerptLooksLikeMutate(excerpt: string): boolean {
  return (
    /\b(rm|mv|chmod|chown|mkdir|touch|tee|sed|dd)\b/.test(excerpt) ||
    excerpt.includes(">") ||
    excerpt.includes("git add") ||
    excerpt.includes("git commit") ||
    excerpt.includes("git push")
  )
}

function isReadOnlySandboxTool(name: string, excerpt: string): boolean {
  if (excerptLooksLikeMutate(excerpt)) return false
  if (
    name.includes("read") ||
    name.includes("grep") ||
    name.includes("glob") ||
    name.includes("list") ||
    name === "ls" ||
    name.includes("search")
  ) {
    return true
  }
  if (name === "bash" || name.includes("bash") || name.includes("shell")) {
    return (
      !excerptLooksLikeMutate(excerpt) &&
      /\b(ls|cat|head|tail|less|find|tree|pwd|wc|file|git status|git log|git diff|git ls-files|git rev-parse)\b/.test(
        excerpt,
      )
    )
  }
  return false
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
    const argsExcerpt = [request.title, request.type, JSON.stringify(request)]
      .filter(Boolean)
      .join(" ")
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

export function parseChatJudgeReply(raw: string): "allow" | "deny" | "garbage" {
  const text = raw.trim().toLowerCase()
  if (text === "allow" || text === "deny") return text
  return "garbage"
}

export async function judgeChatToolWithFastModel(
  toolName: string,
  argsExcerpt: string,
): Promise<"allow" | "deny" | "timeout" | "garbage"> {
  try {
    const { getModel } = await import(
      "../../retrieval/services/modelProvider.js"
    )
    const model = getModel("fast")
    const result = await model.invoke(
      [
        "Decide whether this Workspace chat sandbox tool is safe.",
        "Reply with allow or deny only.",
        `Tool: ${toolName}`,
        `Excerpt: ${argsExcerpt}`,
      ].join("\n"),
    )
    const content = result.content
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                typeof part === "object" && part && "text" in part
                  ? String(part.text)
                  : "",
              )
              .join("")
          : String(content ?? "")
    return parseChatJudgeReply(text)
  } catch {
    return "timeout"
  }
}
