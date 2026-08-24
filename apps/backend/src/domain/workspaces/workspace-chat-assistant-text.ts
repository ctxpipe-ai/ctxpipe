type AguiRecord = {
  type?: string
  messageId?: string
  delta?: string
}

const TEXT_START = "TEXT_MESSAGE_START"
const TEXT_CONTENT = "TEXT_MESSAGE_CONTENT"
const TEXT_END = "TEXT_MESSAGE_END"

type TextClass = "hold" | "drop" | "reply" | "strip"

type OpenText = {
  id: string
  text: string
  held: object[]
  dropped: boolean
  released: boolean
  emittedReplyLen: number
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

function isOpenCodeToolDump(text: string): boolean {
  return (
    text.includes("tanstack-ai-sandboxes") ||
    text.includes(".tanstack-projected-") ||
    (/<path>[\s\S]*<\/path>/.test(text) &&
      /<type>directory<\/type>/.test(text))
  )
}

/** Planning preamble is not the persist reply — wait for the real answer. */
export function isOpenCodePlanningHold(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 280) return false
  if (isOpenCodeToolDump(trimmed)) return false
  return (
    /^(i['’]ll|i will|let me|i['’]m going to|i am going to)\b/i.test(trimmed) &&
    /(inspect|look|check|explore|read|search|summariz|see what)/i.test(trimmed)
  )
}

function isLeftoverLog(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed === "OpenCode chat stream completed" ||
    trimmed.startsWith("Previous conversation:") ||
    trimmed.includes("tanstack-ai:errors") ||
    trimmed.includes("opencode.chatStream") ||
    isOpenCodeToolDump(trimmed)
  )
}

function isSandboxInternalChunk(chunk: object): boolean {
  const record = chunk as {
    type?: string
    content?: unknown
    result?: unknown
    output?: unknown
    delta?: unknown
  }
  if (isTextEvent(record.type) || isTerminalEvent(record.type)) return false
  const blob = [record.content, record.result, record.output, record.delta]
    .map((value) => (typeof value === "string" ? value : ""))
    .join("")
  return blob.length > 0 && isOpenCodeToolDump(blob)
}

function classifyAssistantText(
  prompt: string,
  text: string,
  final: boolean,
): TextClass {
  if (isLeftoverLog(text)) return "drop"
  if (isOpenCodePlanningHold(text)) return "hold"
  if (prompt.length > 0 && text === prompt) return final ? "drop" : "hold"
  if (
    prompt.length > 0 &&
    text.startsWith(prompt) &&
    text.length > prompt.length
  ) {
    return "strip"
  }
  if (text === "") return "hold"
  if (prompt.length > 0 && prompt.startsWith(text)) return "hold"
  const leftoverPrefix = "Previous conversation:"
  if (leftoverPrefix.startsWith(text)) return final ? "drop" : "hold"
  return "reply"
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
  const cleaned = input.texts.filter(
    (text) => !isLeftoverLog(text) && !isOpenCodePlanningHold(text),
  )
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

function replyText(prompt: string, text: string, kind: TextClass): string {
  return kind === "strip" ? text.slice(prompt.length) : text
}

function releaseOpenText(
  open: OpenText,
  prompt: string,
  final: boolean,
): object[] {
  const kind = classifyAssistantText(prompt, open.text, final)
  if (kind === "drop") {
    open.dropped = true
    return []
  }
  if (kind === "hold") return []
  const reply = replyText(prompt, open.text, kind)
  const out: object[] = []
  if (!open.released) {
    open.released = true
    const start = open.held.find(
      (chunk) => (chunk as AguiRecord).type === TEXT_START,
    )
    out.push(start ?? { type: TEXT_START, messageId: open.id })
  }
  const delta = reply.slice(open.emittedReplyLen)
  open.emittedReplyLen = reply.length
  if (delta) {
    out.push({
      type: TEXT_CONTENT,
      messageId: open.id,
      delta,
    })
  }
  return out
}

export function createWorkspaceChatAssistantGate(prompt: string): {
  take: (chunk: object) => object[]
  flush: () => object[]
  assistant: () => string
} {
  const messages: Array<{ id: string; text: string }> = []
  let open: OpenText | null = null
  const heldTerminal: object[] = []

  const closeOpen = (fromEndEvent: boolean): object[] => {
    if (!open) return []
    const kind = classifyAssistantText(prompt, open.text, true)
    const out =
      open.dropped || kind === "drop" || kind === "hold"
        ? []
        : [
            ...releaseOpenText(open, prompt, true),
            ...(fromEndEvent && open.released
              ? [{ type: TEXT_END, messageId: open.id }]
              : []),
          ]
    if (open.text !== "") messages.push({ id: open.id, text: open.text })
    open = null
    return out
  }

  return {
    take(chunk: object) {
      const record = chunk as AguiRecord
      if (isTerminalEvent(record.type)) {
        heldTerminal.push(chunk)
        return []
      }
      if (isSandboxInternalChunk(chunk)) return []
      if (!isTextEvent(record.type)) return [chunk]
      const id = chunkMessageId(record)
      const out: object[] = []
      if (open && id !== open.id) out.push(...closeOpen(true))
      if (!open) {
        open = {
          id,
          text: "",
          held: [],
          dropped: false,
          released: false,
          emittedReplyLen: 0,
        }
      }
      open.held.push(chunk)
      if (record.type === TEXT_CONTENT && typeof record.delta === "string") {
        open.text += record.delta
      }
      if (open.dropped) return out
      if (record.type === TEXT_END) {
        out.push(...closeOpen(true))
        return out
      }
      out.push(...releaseOpenText(open, prompt, false))
      return out
    },
    flush() {
      const trailing = closeOpen(false)
      return [...trailing, ...heldTerminal.splice(0)]
    },
    assistant() {
      if (open && open.text !== "") {
        messages.push({ id: open.id, text: open.text })
        open = null
      }
      return workspaceChatAssistantReply({
        prompt,
        texts: messages.map((message) => message.text),
      })
    },
  }
}
