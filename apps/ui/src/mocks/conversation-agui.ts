export function conversationAguiTextEvents(input: {
  threadId: string
  runId?: string
  messageId: string
  text: string
}): object[] {
  const runId = input.runId ?? "run_1"
  return [
    { type: "RUN_STARTED", threadId: input.threadId, runId },
    {
      type: "TEXT_MESSAGE_START",
      messageId: input.messageId,
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: input.messageId,
      delta: input.text,
    },
    { type: "TEXT_MESSAGE_END", messageId: input.messageId },
    { type: "RUN_FINISHED", threadId: input.threadId, runId },
  ]
}

/**
 * Replace `window.WebSocket` with a socket that answers each AG-UI run frame
 * with `events(threadId, runId, index)`, one frame per chunk, as the backend
 * does. `index` counts the run frames from 0.
 */
export function installAguiWebSocket(
  events: (threadId: string, runId: string, index: number) => object[],
) {
  const Original = window.WebSocket
  const runFrames: unknown[] = []
  function AguiWebSocket(url: string | URL) {
    const listeners = new Map<string, Set<(event: Event) => void>>()
    const emit = (type: string, event: Event) => {
      const handler = socket[`on${type}` as keyof typeof socket]
      if (typeof handler === "function") {
        ;(handler as (event: Event) => void)(event)
      }
      for (const listener of listeners.get(type) ?? []) listener(event)
    }
    const socket = {
      url: String(url),
      readyState: Original.CONNECTING as number,
      bufferedAmount: 0,
      extensions: "",
      protocol: "",
      binaryType: "blob" as BinaryType,
      onopen: null as ((event: Event) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      onclose: null as ((event: CloseEvent) => void) | null,
      onmessage: null as ((event: MessageEvent<string>) => void) | null,
      close() {
        if (socket.readyState === Original.CLOSED) return
        socket.readyState = Original.CLOSED
        emit("close", new CloseEvent("close", { code: 1000 }))
      },
      send(data: string) {
        const frame = JSON.parse(data) as { threadId?: string; runId?: string }
        if (!frame.runId) return
        const chunks = events(
          frame.threadId ?? "",
          frame.runId,
          runFrames.push(frame) - 1,
        )
        void (async () => {
          for (const chunk of chunks) {
            await new Promise((resolve) => setTimeout(resolve, 20))
            if (socket.readyState !== Original.OPEN) return
            emit(
              "message",
              new MessageEvent("message", { data: JSON.stringify(chunk) }),
            )
          }
        })()
      },
      addEventListener(type: string, listener: (event: Event) => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener(type: string, listener: (event: Event) => void) {
        listeners.get(type)?.delete(listener)
      },
      dispatchEvent() {
        return true
      },
    }
    setTimeout(() => {
      if (socket.readyState !== Original.CONNECTING) return
      socket.readyState = Original.OPEN
      emit("open", new Event("open"))
    }, 0)
    return socket
  }
  AguiWebSocket.prototype = Original.prototype
  Object.assign(AguiWebSocket, {
    CONNECTING: Original.CONNECTING,
    OPEN: Original.OPEN,
    CLOSING: Original.CLOSING,
    CLOSED: Original.CLOSED,
  })
  window.WebSocket = AguiWebSocket as unknown as typeof WebSocket
  return {
    runFrames,
    restore() {
      window.WebSocket = Original
    },
  }
}
