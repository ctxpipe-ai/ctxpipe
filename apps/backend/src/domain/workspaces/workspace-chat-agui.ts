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

export const WORKSPACE_CHAT_STREAM_SETUP_MS = 180_000
/** Reasoning + tool turns can sit silent longer than a short idle window. */
export const WORKSPACE_CHAT_STREAM_IDLE_MS = 180_000

export function isWorkspaceChatTerminalChunk(chunk: object): boolean {
  const type = (chunk as { type?: string }).type
  return type === "RUN_FINISHED" || type === "RUN_ERROR"
}

export async function* withWorkspaceChatHeartbeats(
  stream: AsyncIterable<StreamChunk>,
  intervalMs = WORKSPACE_CHAT_HEARTBEAT_MS,
): AsyncGenerator<StreamChunk> {
  const iterator = stream[Symbol.asyncIterator]()
  try {
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
  } finally {
    // A hung OpenCode iterator.return() must not block claim release.
    void iterator.return?.()
  }
}

/**
 * Drive an OpenCode/TanStack producer until it finishes or goes silent.
 * Stock `@tanstack/ai-opencode` can keep `mergeChunkStreams` open after
 * `RUN_FINISHED`; stop there so the turn claim can release.
 */
export async function* takeWorkspaceChatProducer(
  stream: AsyncIterable<object>,
  input?: {
    setupMs?: number
    idleMs?: number
    afterTerminal?: () => Promise<void> | void
  },
): AsyncGenerator<object> {
  const setupMs = input?.setupMs ?? WORKSPACE_CHAT_STREAM_SETUP_MS
  const idleMs = input?.idleMs ?? WORKSPACE_CHAT_STREAM_IDLE_MS
  const iterator = stream[Symbol.asyncIterator]()
  let stallMs = setupMs
  try {
    let pending = iterator.next()
    for (;;) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const raced = await Promise.race([
        pending.then((result) => ({ kind: "chunk" as const, result })),
        new Promise<{ kind: "stall" }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "stall" }), stallMs)
        }),
      ])
      if (timeout) clearTimeout(timeout)
      if (raced.kind === "stall") {
        throw new Error("workspace chat stream stalled")
      }
      if (raced.result.done) return
      const chunk = raced.result.value
      yield chunk
      if (isWorkspaceChatTerminalChunk(chunk)) {
        // Keep the producer (and model proxy) open while OpenCode finishes.
        await input?.afterTerminal?.()
        return
      }
      stallMs = idleMs
      pending = iterator.next()
    }
  } finally {
    void iterator.return?.()
  }
}

function abortControllerForRequest(request?: Request): AbortController {
  const abortController = new AbortController()
  const signal = request?.signal
  if (!signal) return abortController
  if (signal.aborted) abortController.abort(signal.reason)
  else {
    signal.addEventListener("abort", () => abortController.abort(signal.reason), {
      once: true,
    })
  }
  return abortController
}

export function workspaceChatHttpResponse(
  stream: AsyncIterable<StreamChunk>,
  format: WorkspaceChatWireFormat = "sse",
  request?: Request,
): Response {
  const abortController = abortControllerForRequest(request)
  return format === "ndjson"
    ? toHttpResponse(stream, { abortController })
    : toServerSentEventsResponse(stream, { abortController })
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
