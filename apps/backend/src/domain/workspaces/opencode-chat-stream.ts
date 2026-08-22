import { log } from "../../observability/logger.js"

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

export const OPENCODE_CHAT_STREAM_STEP = "opencode.chatStream" as const

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

export function opencodeChatStreamExcerpt(value: unknown, max = 400): string {
  if (value == null) return ""
  const raw =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : JSON.stringify(value)
  const text = stripAnsi(raw).replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function opencodeHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  const record = error as { status?: unknown; statusCode?: unknown }
  const status = record.status ?? record.statusCode
  return typeof status === "number" && Number.isFinite(status) ? status : null
}

/** Fields for the single chat-attempt wide event (success and fail). */
export function opencodeChatStreamEvent(input: {
  conversationId: string
  workspaceId: string
  error?: unknown
  provider?: string | null
  opencodePort?: number
  durationMs?: number
  stderrExcerpt?: string
}): Record<string, unknown> {
  const failed = input.error != null
  const status = failed ? opencodeHttpStatus(input.error) : 200
  const bodyExcerpt = failed
    ? opencodeChatStreamExcerpt(input.stderrExcerpt) ||
      opencodeChatStreamExcerpt(input.error)
    : ""
  return {
    step: OPENCODE_CHAT_STREAM_STEP,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    status,
    bodyExcerpt,
    message: failed
      ? bodyExcerpt || "OpenCode chat stream failed"
      : "OpenCode chat stream completed",
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.opencodePort != null ? { opencodePort: input.opencodePort } : {}),
    ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
  }
}

/**
 * Chat streams keep running after Hono emits the HTTP wide event.
 * Writing to `getLogger()` is dropped (`log.set() called after … emitted`).
 * Standalone `log` emits a second event that Better Stack / Railway keep.
 */
export function emitOpencodeChatAttempt(
  fields: ReturnType<typeof opencodeChatStreamEvent>,
  error?: Error | null,
): void {
  if (error) {
    log.error({
      ...fields,
      error: error.message,
    })
    return
  }
  log.info(fields)
}

export function isOpencodeChatFatal(error: unknown): boolean {
  const text = opencodeChatStreamExcerpt(error).toLowerCase()
  return (
    text.includes("opencode.chatstream") ||
    text.includes("unexpected server error") ||
    text.includes("tanstack-ai:errors")
  )
}

export function shouldFailEmptyChatTurn(input: {
  assistant: string
  error?: unknown
}): boolean {
  if (input.assistant.trim().length > 0) return false
  return input.error != null
}

/** Fold TanStack/OpenCode console fatals into one captured error. */
export async function withTanstackConsoleCapture<T>(
  run: () => Promise<T>,
): Promise<{ result: T; fatal: Error | null }> {
  const captured: Error[] = []
  const original = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  }
  const intercept = (...args: unknown[]) => {
    const text = args.map((arg) => opencodeChatStreamExcerpt(arg)).join(" ")
    if (
      text.includes("tanstack-ai:errors") ||
      text.includes("opencode.chatStream") ||
      text.includes("Unexpected server error")
    ) {
      captured.push(new Error(stripAnsi(text)))
    }
  }
  console.error = intercept
  console.info = intercept
  console.log = intercept
  console.warn = intercept
  try {
    const result = await run()
    return { result, fatal: captured[0] ?? null }
  } catch (error) {
    if (error instanceof Error) captured.unshift(error)
    else captured.unshift(new Error(String(error)))
    throw captured[0]
  } finally {
    console.error = original.error
    console.info = original.info
    console.log = original.log
    console.warn = original.warn
  }
}

export function httpWideEventMessage(input: {
  method?: unknown
  path?: unknown
  status?: unknown
}): string | undefined {
  if (typeof input.method !== "string" || typeof input.path !== "string") {
    return undefined
  }
  const status =
    typeof input.status === "number"
      ? String(input.status)
      : typeof input.status === "string"
        ? input.status
        : ""
  return status
    ? `${input.method} ${input.path} ${status}`
    : `${input.method} ${input.path}`
}
