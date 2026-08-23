import {
  toHttpResponse,
  toServerSentEventsResponse,
  type StreamChunk,
} from "@tanstack/ai"
import { generateObjectId } from "../../lib/id.js"

export const WORKSPACE_CHAT_HEARTBEAT_MS = 10_000
export const WORKSPACE_CHAT_RENAME_EVENT = "rename-conversation"
export const WORKSPACE_CHAT_HEARTBEAT_EVENT = "heartbeat"

export type WorkspaceChatWireFormat = "sse" | "ndjson"

export function workspaceChatWireFormat(request: Request): WorkspaceChatWireFormat {
  const accept = request.headers.get("accept") ?? ""
  if (accept.includes("application/x-ndjson") || accept.includes("application/jsonl")) {
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

export function workspaceChatRunStarted(input: {
  conversationId: string
  runId?: string
}): StreamChunk {
  return {
    type: "RUN_STARTED",
    threadId: input.conversationId,
    runId: input.runId ?? generateObjectId("run"),
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

export async function* withWorkspaceChatHeartbeats(
  stream: AsyncIterable<StreamChunk>,
  intervalMs = WORKSPACE_CHAT_HEARTBEAT_MS,
): AsyncGenerator<StreamChunk> {
  const iterator = stream[Symbol.asyncIterator]()
  let pending = iterator.next()
  for (;;) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const raced = await Promise.race([
      pending.then((result) => ({ kind: "chunk" as const, result })),
      new Promise<{ kind: "tick" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "tick" }), intervalMs)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    if (raced.kind === "tick") {
      yield {
        type: "CUSTOM",
        name: WORKSPACE_CHAT_HEARTBEAT_EVENT,
        value: { at: Date.now() },
        timestamp: Date.now(),
      } as StreamChunk
      continue
    }
    if (raced.result.done) return
    yield raced.result.value
    pending = iterator.next()
  }
}

export function workspaceChatHttpResponse(
  stream: AsyncIterable<StreamChunk>,
  format: WorkspaceChatWireFormat = "sse",
): Response {
  return format === "ndjson"
    ? toHttpResponse(stream)
    : toServerSentEventsResponse(stream)
}

export function parseSseDataLines(body: string): object[] {
  const events: object[] = []
  for (const block of body.split("\n\n")) {
    const line = block.split("\n").find((entry) => entry.startsWith("data: "))
    if (!line) continue
    try {
      events.push(JSON.parse(line.slice(6)) as object)
    } catch {
      continue
    }
  }
  return events
}
