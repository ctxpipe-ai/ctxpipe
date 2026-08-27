import type { ChatMessage } from "@/features/chat/types"
import type { ConversationGitTreeResponse } from "./types"

const WRITE_TOOL_NAMES = ["write", "edit", "apply_patch", "commit"] as const
const BASH_TOOL_NAMES = ["bash", "shell"] as const
const HARNESS_WRITE_PREFIXES = [
  "opencode.json",
  ".tanstack-projected-",
  "tm/",
  "tmp/tanstack-ai-",
] as const

export const CONVERSATION_TREE_LIVE_POLL_MS = 400
export const CONVERSATION_TREE_BOOTSTRAP_POLL_MS = 2000

export function conversationChatRunIsLive(status: string | undefined): boolean {
  return status === "submitted" || status === "streaming"
}

export function conversationToolLooksLikeWrite(toolName: string | undefined): boolean {
  const name = (toolName ?? "").toLowerCase()
  return (
    WRITE_TOOL_NAMES.some((tool) => name === tool) ||
    BASH_TOOL_NAMES.some((tool) => name === tool)
  )
}

export function conversationTreeRefetchInterval(live: boolean) {
  return (query: { state: { data?: unknown } }) => {
    if (live) return CONVERSATION_TREE_LIVE_POLL_MS
    return query.state.data ? false : CONVERSATION_TREE_BOOTSTRAP_POLL_MS
  }
}

export function sanitizeConversationWritePath(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("/") || trimmed.includes("..")) return null
  const posix = trimmed.replace(/\\/g, "/").replace(/^\.\//, "")
  if (!posix || posix.startsWith("/")) return null
  if (posix.startsWith("/dev/") || posix === "/dev/null") return null
  if (
    HARNESS_WRITE_PREFIXES.some(
      (prefix) => posix === prefix.replace(/\/$/, "") || posix.startsWith(prefix),
    )
  ) {
    return null
  }
  return posix
}

function unquoteBashToken(token: string): string {
  const trimmed = token.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Destination of `>`, `>>`, `tee`/`tee -a`, or `touch` in a bash command. */
export function conversationWritePathFromBash(command: string | undefined): string | null {
  if (!command) return null
  const quotedRedirect = command.match(/(?:>>|>)\s*(['"])([^'"]+)\1/)
  if (quotedRedirect?.[2]) return sanitizeConversationWritePath(quotedRedirect[2])
  const bareRedirect = command.match(/(?:>>|>)\s*([^\s;&|<>]+)/)
  if (bareRedirect?.[1]) {
    return sanitizeConversationWritePath(unquoteBashToken(bareRedirect[1]))
  }
  const tee = command.match(/\btee(?:\s+-a)?\s+((['"])([^'"]+)\2|[^\s;&|<>]+)/)
  if (tee?.[1]) return sanitizeConversationWritePath(unquoteBashToken(tee[1]))
  const touch = command.match(/\btouch\s+((['"])([^'"]+)\2|[^\s;&|<>]+)/)
  if (touch?.[1]) return sanitizeConversationWritePath(unquoteBashToken(touch[1]))
  return null
}

function toolNameOf(part: {
  type?: string
  name?: string
  toolName?: string
}): string | undefined {
  return part.name ?? part.toolName
}

function isToolPart(part: { type?: string }): boolean {
  return part.type === "tool-call" || part.type === "tool-invocation"
}

export function conversationWritePathFromTool(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): string | null {
  const name = (toolName ?? "").toLowerCase()
  if (BASH_TOOL_NAMES.some((tool) => name === tool)) {
    const command =
      typeof input?.command === "string"
        ? input.command
        : typeof input?.cmd === "string"
          ? input.cmd
          : undefined
    return conversationWritePathFromBash(command)
  }
  if (!WRITE_TOOL_NAMES.some((tool) => name === tool)) return null
  const raw =
    (typeof input?.path === "string" && input.path) ||
    (typeof input?.filePath === "string" && input.filePath) ||
    (typeof input?.file === "string" && input.file) ||
    (typeof input?.file_path === "string" && input.file_path) ||
    undefined
  return sanitizeConversationWritePath(raw)
}

function toolInputOf(part: {
  input?: unknown
  data?: unknown
}): Record<string, unknown> | undefined {
  if (part.input && typeof part.input === "object" && !Array.isArray(part.input)) {
    return part.input as Record<string, unknown>
  }
  if (part.data && typeof part.data === "object" && !Array.isArray(part.data)) {
    return part.data as Record<string, unknown>
  }
  return undefined
}

export function conversationWriteToolPaths(
  messages: readonly Pick<ChatMessage, "parts">[],
): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolPart(part)) continue
      const path = conversationWritePathFromTool(toolNameOf(part), toolInputOf(part))
      if (path && !seen.has(path)) {
        seen.add(path)
        paths.push(path)
      }
    }
  }
  return paths
}

/** Fingerprint so unparsed bash still invalidates the tree. */
export function conversationWriteToolSignature(
  messages: readonly Pick<ChatMessage, "parts">[],
): string {
  const tokens: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolPart(part)) continue
      const name = toolNameOf(part)
      if (!conversationToolLooksLikeWrite(name)) continue
      const input = toolInputOf(part)
      const path = conversationWritePathFromTool(name, input)
      if (path) {
        tokens.push(path)
        continue
      }
      const tool = (name ?? "").toLowerCase()
      if (BASH_TOOL_NAMES.some((bash) => tool === bash)) {
        const command =
          typeof input?.command === "string"
            ? input.command
            : typeof input?.cmd === "string"
              ? input.cmd
              : ""
        if (command) tokens.push(`bash:${command}`)
      }
    }
  }
  return tokens.join("\0")
}

export function addOptimisticConversationTreePath(
  tree: ConversationGitTreeResponse | undefined,
  nextPath: string,
  fallback: { sha: string; branch: string },
): ConversationGitTreeResponse {
  const sha = tree?.sha || fallback.sha
  const branch = tree?.branch || fallback.branch
  const paths = tree?.paths ?? []
  if (paths.includes(nextPath)) {
    return tree ?? { sha, branch, paths }
  }
  return {
    sha,
    branch,
    paths: [...paths, nextPath].sort((left, right) => left.localeCompare(right)),
  }
}

export type PendingConversationToolCall = {
  name?: string
  argsText: string
}

export function conversationWriteFromStreamChunk(
  pending: Map<string, PendingConversationToolCall>,
  chunk: {
    type?: string
    toolCallId?: string
    toolCallName?: string
    input?: Record<string, unknown>
    delta?: string
  },
): { path: string | null; writeEnded: boolean } {
  const type = chunk.type ?? ""
  const id = chunk.toolCallId ?? ""
  if (type === "TOOL_CALL_START" && id) {
    pending.set(id, { name: chunk.toolCallName, argsText: "" })
    return { path: null, writeEnded: false }
  }
  if (type === "TOOL_CALL_ARGS" && id) {
    const existing = pending.get(id) ?? { argsText: "" }
    existing.argsText += chunk.delta ?? ""
    pending.set(id, existing)
    const parsed = tryParseJsonObject(existing.argsText)
    return {
      path: conversationWritePathFromTool(existing.name, parsed),
      writeEnded: false,
    }
  }
  if ((type === "TOOL_CALL_END" || type === "TOOL_CALL_RESULT") && id) {
    const existing = pending.get(id)
    const input = chunk.input ?? tryParseJsonObject(existing?.argsText ?? "")
    const name = existing?.name ?? chunk.toolCallName
    pending.delete(id)
    return {
      path: conversationWritePathFromTool(name, input),
      writeEnded: conversationToolLooksLikeWrite(name),
    }
  }
  return { path: null, writeEnded: false }
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
