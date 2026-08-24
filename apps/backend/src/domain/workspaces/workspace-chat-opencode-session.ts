import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { workspaceChatOpenCodeHomeDir } from "./workspace-chat-opencode-contract.js"
import {
  isOpenCodePlanningHold,
  workspaceChatAssistantReply,
} from "./workspace-chat-assistant-text.js"

const SESSION_FILE = "ctxpipe-session-id"

function sessionFilePath(conversationId: string): string {
  return join(workspaceChatOpenCodeHomeDir(conversationId), SESSION_FILE)
}

/** Official OpenCode resume id from the previous turn (`modelOptions.sessionId`). */
export function loadWorkspaceChatOpenCodeSessionId(
  conversationId: string,
): string | null {
  try {
    const value = readFileSync(sessionFilePath(conversationId), "utf8").trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

export function persistWorkspaceChatOpenCodeSessionId(
  conversationId: string,
  sessionId: string,
): void {
  const trimmed = sessionId.trim()
  if (!trimmed) return
  const home = workspaceChatOpenCodeHomeDir(conversationId)
  mkdirSync(home, { recursive: true })
  writeFileSync(sessionFilePath(conversationId), `${trimmed}\n`, "utf8")
}

export function clearWorkspaceChatOpenCodeSessionId(
  conversationId: string,
): void {
  try {
    unlinkSync(sessionFilePath(conversationId))
  } catch {
    // No session stored for this conversation.
  }
}

export const WORKSPACE_CHAT_OPENCODE_IDLE_WAIT_MS = 60_000
export const WORKSPACE_CHAT_OPENCODE_IDLE_POLL_MS = 250

export function workspaceChatOpenCodeSessionId(chunk: object): string | null {
  const record = chunk as { type?: string; name?: string; value?: unknown }
  if (record.type !== "CUSTOM") return null
  if (record.name !== "opencode.session-id") return null
  if (typeof record.value === "string" && record.value.trim()) {
    return record.value.trim()
  }
  if (record.value && typeof record.value === "object") {
    const value = record.value as { sessionId?: unknown; id?: unknown }
    if (typeof value.sessionId === "string" && value.sessionId.trim()) {
      return value.sessionId.trim()
    }
    if (typeof value.id === "string" && value.id.trim()) {
      return value.id.trim()
    }
  }
  return null
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const record = part as { type?: unknown; text?: unknown }
      if (record.type !== "text" || typeof record.text !== "string") return ""
      return record.text
    })
    .join("")
}

export function assistantTextFromOpenCodeMessages(
  payload: unknown,
  prompt: string,
): string {
  if (!Array.isArray(payload)) return ""
  const texts: string[] = []
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as { info?: { role?: unknown }; parts?: unknown }
    if (record.info?.role !== "assistant") continue
    const text = textFromParts(record.parts).trim()
    if (text) texts.push(text)
  }
  return workspaceChatAssistantReply({ prompt, texts })
}

export type WorkspaceChatFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export async function waitForOpenCodeAssistant(input: {
  port: number
  sessionId: string
  prompt: string
  timeoutMs?: number
  pollMs?: number
  fetch?: WorkspaceChatFetch
}): Promise<string> {
  const timeoutMs = input.timeoutMs ?? WORKSPACE_CHAT_OPENCODE_IDLE_WAIT_MS
  const pollMs = input.pollMs ?? WORKSPACE_CHAT_OPENCODE_IDLE_POLL_MS
  const doFetch = input.fetch ?? fetch
  const url = `http://127.0.0.1:${input.port}/session/${input.sessionId}/message`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await doFetch(url)
      if (res.ok) {
        const text = assistantTextFromOpenCodeMessages(
          await res.json(),
          input.prompt,
        )
        if (text.trim() && !isOpenCodePlanningHold(text)) return text
      }
    } catch {
      // Serve may still be writing the turn.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return ""
}
