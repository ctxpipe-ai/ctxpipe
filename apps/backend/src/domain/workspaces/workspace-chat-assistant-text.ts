type AguiRecord = {
  type?: string
  messageId?: string
  delta?: string
}

const TEXT_START = "TEXT_MESSAGE_START"
const TEXT_CONTENT = "TEXT_MESSAGE_CONTENT"
const TEXT_END = "TEXT_MESSAGE_END"

type TextMessage = {
  id: string
  text: string
}

function isTextEvent(type: string | undefined): boolean {
  return type === TEXT_START || type === TEXT_CONTENT || type === TEXT_END
}

function isTerminalEvent(type: string | undefined): boolean {
  return type === "RUN_FINISHED" || type === "RUN_ERROR"
}

function chunkMessageId(chunk: AguiRecord): string {
  return typeof chunk.messageId === "string" && chunk.messageId.length > 0
    ? chunk.messageId
    : "__default__"
}

function isLeftoverLog(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed === "OpenCode chat stream completed" ||
    trimmed.startsWith("Previous conversation:") ||
    trimmed.includes("tanstack-ai:errors") ||
    trimmed.includes("opencode.chatStream")
  )
}

/**
 * Harness echo is a leading text message equal to the user prompt when a later
 * assistant text message exists, or one messageId prefixed with the prompt.
 * The persist reply is the last remaining text message. Echo-only is empty.
 */
export function workspaceChatAssistantReply(input: {
  prompt: string
  texts: string[]
}): string {
  const prompt = input.prompt
  const cleaned = input.texts.filter((text) => !isLeftoverLog(text))
  const texts =
    cleaned.length > 1 && cleaned[0] === prompt
      ? cleaned.slice(1)
      : [...cleaned]
  const last = texts.at(-1) ?? ""
  if (
    texts.length === 1 &&
    prompt.length > 0 &&
    last.startsWith(prompt) &&
    last.length > prompt.length
  ) {
    return last.slice(prompt.length)
  }
  if (last === prompt) return ""
  return last
}

export function createWorkspaceChatAssistantGate(prompt: string): {
  take: (chunk: object) => object[]
  flush: () => object[]
  assistant: () => string
} {
  const messages: TextMessage[] = []
  let open: TextMessage | null = null
  const held: object[] = []

  const closeOpen = (): void => {
    if (!open) return
    if (open.text !== "") messages.push(open)
    open = null
  }

  return {
    take(chunk: object) {
      const record = chunk as AguiRecord
      if (isTerminalEvent(record.type)) {
        held.push(chunk)
        return []
      }
      if (!isTextEvent(record.type)) return [chunk]
      const id = chunkMessageId(record)
      if (open && id !== open.id) closeOpen()
      if (!open) open = { id, text: "" }
      if (record.type === TEXT_CONTENT && typeof record.delta === "string") {
        open.text += record.delta
      }
      return [chunk]
    },
    flush() {
      closeOpen()
      const terminal = held.splice(0)
      return terminal
    },
    assistant() {
      closeOpen()
      return workspaceChatAssistantReply({
        prompt,
        texts: messages.map((message) => message.text),
      })
    },
  }
}
