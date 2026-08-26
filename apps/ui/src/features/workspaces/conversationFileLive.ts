import type { ChatMessage } from "@/features/chat/types"

const WRITE_TOOL_NAMES = ["write", "edit", "apply_patch", "commit"] as const

function toolNameLooksLikeWrite(name: string): boolean {
  const lower = name.toLowerCase()
  return WRITE_TOOL_NAMES.some(
    (tool) => lower === tool || lower.includes(tool),
  )
}

function pathFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  for (const key of ["path", "filePath", "file_path", "file"]) {
    const candidate = record[key]
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim()
    }
  }
  return null
}

export function conversationWriteToolPaths(
  messages: readonly Pick<ChatMessage, "parts">[],
): string[] {
  const paths = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      const name = part.name ?? part.type
      if (!name || !toolNameLooksLikeWrite(name)) continue
      const path =
        pathFromUnknown(part.input) ??
        pathFromUnknown(part.data) ??
        (typeof part.content === "string" ? part.content : null)
      if (path?.includes("/") || (path && !path.includes(" "))) {
        paths.add(path)
      }
    }
  }
  return [...paths]
}

export function conversationWriteToolSignature(
  messages: readonly Pick<ChatMessage, "parts">[],
): string {
  return conversationWriteToolPaths(messages).join("\0")
}
