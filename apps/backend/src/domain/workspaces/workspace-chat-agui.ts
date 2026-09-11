import {
  type StreamChunk,
  toHttpResponse,
  toServerSentEventsResponse,
} from "@tanstack/ai"

export const WORKSPACE_CHAT_RENAME_EVENT = "rename-conversation"

export type WorkspaceChatWireFormat = "sse" | "ndjson"

export function workspaceChatWireFormat(
  request: Request,
): WorkspaceChatWireFormat {
  const accept = request.headers.get("accept") ?? ""
  if (
    accept.includes("application/x-ndjson") ||
    accept.includes("application/jsonl")
  ) {
    return "ndjson"
  }
  return "sse"
}

export function conversationRenameChunk(name: string): StreamChunk {
  return {
    type: "CUSTOM",
    name: WORKSPACE_CHAT_RENAME_EVENT,
    value: { name },
    timestamp: Date.now(),
  } as StreamChunk
}

export function workspaceChatRunError(message: string): StreamChunk {
  return {
    type: "RUN_ERROR",
    message,
    timestamp: Date.now(),
  } as StreamChunk
}

export function aguiTextDelta(chunk: object): string {
  const record = chunk as Record<string, unknown>
  if (
    record.type === "TEXT_MESSAGE_CONTENT" &&
    typeof record.delta === "string"
  ) {
    return record.delta
  }
  return ""
}

export function isWorkspaceChatRenameChunk(chunk: object): string | null {
  const record = chunk as Record<string, unknown>
  if (record.type !== "CUSTOM" || record.name !== WORKSPACE_CHAT_RENAME_EVENT) {
    return null
  }
  const value = record.value
  if (
    value &&
    typeof value === "object" &&
    "name" in value &&
    typeof (value as { name: unknown }).name === "string"
  ) {
    return (value as { name: string }).name
  }
  return null
}

function abortControllerForRequest(request?: Request): AbortController {
  const abortController = new AbortController()
  const signal = request?.signal
  if (!signal) return abortController
  if (signal.aborted) abortController.abort(signal.reason)
  else {
    signal.addEventListener(
      "abort",
      () => abortController.abort(signal.reason),
      {
        once: true,
      },
    )
  }
  return abortController
}

export function workspaceChatHttpResponse(
  stream: AsyncIterable<StreamChunk>,
  format: WorkspaceChatWireFormat = "sse",
  request?: Request,
): Response {
  const abortController = abortControllerForRequest(request)
  const headers = { "X-Accel-Buffering": "no" }
  return format === "ndjson"
    ? toHttpResponse(stream, { abortController, headers })
    : toServerSentEventsResponse(stream, { abortController, headers })
}
