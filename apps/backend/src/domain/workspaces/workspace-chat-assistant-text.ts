type AguiRecord = {
  type?: string
  messageId?: string
  delta?: string
}

const TEXT_START = "TEXT_MESSAGE_START"
const TEXT_CONTENT = "TEXT_MESSAGE_CONTENT"
const TEXT_END = "TEXT_MESSAGE_END"

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

export function createWorkspaceChatAssistantGate(prompt: string): {
  take: (chunk: object) => object[]
  flush: () => object[]
  assistant: () => string
} {
  const texts: string[] = []
  let openId: string | null = null
  let openText = ""
  let openChunks: object[] = []
  let heldPromptEcho: object[] | null = null
  let streamLive = false

  const closeOpen = (opts: { final: boolean }): object[] => {
    if (openId == null && openChunks.length === 0 && openText === "") {
      if (opts.final && heldPromptEcho && texts.length === 1) {
        const kept = heldPromptEcho
        heldPromptEcho = null
        return kept
      }
      return []
    }
    const text = openText
    const chunks = openChunks
    const id = openId
    openId = null
    openText = ""
    openChunks = []
    texts.push(text)

    if (heldPromptEcho == null && texts.length === 1 && text === prompt) {
      if (opts.final) return chunks
      heldPromptEcho = chunks
      return []
    }
    heldPromptEcho = null
    if (
      texts.length === 1 &&
      prompt.length > 0 &&
      text.startsWith(prompt) &&
      text.length > prompt.length
    ) {
      return [
        {
          type: TEXT_CONTENT,
          ...(id && id !== "__default__" ? { messageId: id } : {}),
          delta: text.slice(prompt.length),
        },
      ]
    }
    streamLive = true
    return chunks
  }

  return {
    take(chunk: object) {
      const record = chunk as AguiRecord
      if (!isTextEvent(record.type)) {
        const final =
          record.type === "RUN_FINISHED" || record.type === "RUN_ERROR"
        return [...closeOpen({ final }), chunk]
      }
      const id = chunkMessageId(record)
      if (openId != null && id !== openId) {
        const closed = closeOpen({ final: false })
        openId = id
        openChunks = [chunk]
        openText =
          record.type === TEXT_CONTENT && typeof record.delta === "string"
            ? record.delta
            : ""
        if (streamLive) return [...closed, chunk]
        return closed
      }
      openId = id
      openChunks.push(chunk)
      if (record.type === TEXT_CONTENT && typeof record.delta === "string") {
        openText += record.delta
      }
      if (streamLive) return [chunk]
      return []
    },
    flush() {
      return closeOpen({ final: true })
    },
    assistant() {
      return workspaceChatAssistantReply({ prompt, texts })
    },
  }
}
