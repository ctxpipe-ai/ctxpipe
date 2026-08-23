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
  chunks: object[]
}

function isTextEvent(type: string | undefined): boolean {
  return type === TEXT_START || type === TEXT_CONTENT || type === TEXT_END
}

function chunkMessageId(chunk: AguiRecord): string {
  return typeof chunk.messageId === "string" && chunk.messageId.length > 0
    ? chunk.messageId
    : "__default__"
}

/**
 * Harness echo is a leading text message equal to the user prompt when a later
 * assistant text message exists, or one messageId prefixed with the prompt.
 * The persist reply is the last remaining text message.
 */
export function workspaceChatAssistantReply(input: {
  prompt: string
  texts: string[]
}): string {
  const prompt = input.prompt
  const texts =
    input.texts.length > 1 && input.texts[0] === prompt
      ? input.texts.slice(1)
      : [...input.texts]
  const last = texts.at(-1) ?? ""
  if (
    texts.length === 1 &&
    prompt.length > 0 &&
    last.startsWith(prompt) &&
    last.length > prompt.length
  ) {
    return last.slice(prompt.length)
  }
  return last
}

function lastReplyMessage(
  prompt: string,
  messages: TextMessage[],
): TextMessage | null {
  const usable =
    messages.length > 1 && messages[0]?.text === prompt
      ? messages.slice(1)
      : messages
  const last = usable.at(-1)
  if (!last) return null
  const reply = workspaceChatAssistantReply({
    prompt,
    texts: usable.map((message) => message.text),
  })
  if (reply === last.text) return last
  return {
    id: last.id,
    text: reply,
    chunks: [
      {
        type: TEXT_CONTENT,
        ...(last.id !== "__default__" ? { messageId: last.id } : {}),
        delta: reply,
      },
    ],
  }
}

export function createWorkspaceChatAssistantGate(prompt: string): {
  take: (chunk: object) => object[]
  flush: () => object[]
  assistant: () => string
} {
  const messages: TextMessage[] = []
  let open: TextMessage | null = null
  let emitted = false

  const closeOpen = (): void => {
    if (!open) return
    if (open.chunks.length > 0 || open.text !== "") messages.push(open)
    open = null
  }

  const emitLast = (): object[] => {
    if (emitted) return []
    closeOpen()
    emitted = true
    return lastReplyMessage(prompt, messages)?.chunks ?? []
  }

  return {
    take(chunk: object) {
      const record = chunk as AguiRecord
      if (!isTextEvent(record.type)) {
        const final =
          record.type === "RUN_FINISHED" || record.type === "RUN_ERROR"
        if (final) return [...emitLast(), chunk]
        return [chunk]
      }
      const id = chunkMessageId(record)
      if (open && id !== open.id) closeOpen()
      if (!open) open = { id, text: "", chunks: [] }
      open.chunks.push(chunk)
      if (record.type === TEXT_CONTENT && typeof record.delta === "string") {
        open.text += record.delta
      }
      return []
    },
    flush() {
      return emitLast()
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
