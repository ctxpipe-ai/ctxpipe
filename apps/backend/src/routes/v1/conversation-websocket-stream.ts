import {
  memoryStream,
  resumeWebSocketStream,
  type StreamChunk,
  type StreamDurability,
  toWebSocketStream,
  type WebSocketLike,
} from "@tanstack/ai"

const WORKSPACE_CHAT_WS_PATH =
  /^\/([^/]+)\/api\/v1\/conversations\/([^/]+)(?:\/stream)?$/

export function parseConversationWebSocketUpgradeUrl(
  url: string,
): { orgSlug: string; conversationId: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const match = parsed.pathname.match(WORKSPACE_CHAT_WS_PATH)
  const orgSlug = match?.[1]
  const conversationId = match?.[2]
  if (!orgSlug || !conversationId) return null
  return { orgSlug, conversationId }
}

export function isWorkspaceChatWebSocketRequest(request: Request): boolean {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return false
  }
  return WORKSPACE_CHAT_WS_PATH.test(new URL(request.url).pathname)
}

export function conversationWebSocketHasResumeOffset(url: string): boolean {
  try {
    return new URL(url).searchParams.get("offset") !== null
  } catch {
    return false
  }
}

type ConversationChatSocketRun = Parameters<
  typeof toWebSocketStream
>[2]["onRun"]

/**
 * The turns that run in this process, by run log key. A turn continues when
 * the socket that started it closes, so the Stop of a turn can come on a
 * later socket of the same user in the same conversation.
 */
const runningTurns = new Map<string, AbortController>()

function abortFrameRunId(data: unknown): string | undefined {
  if (typeof data !== "string") return undefined
  try {
    const frame = JSON.parse(data) as { type?: unknown; runId?: unknown }
    return frame.type === "abort" && typeof frame.runId === "string"
      ? frame.runId
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Give `toWebSocketStream` a socket that keeps the close of the browser
 * socket until each turn has closed its run log. `toWebSocketStream` stops
 * every turn of a closed socket, but a turn must continue when the user
 * leaves the conversation. The turn writes its run log for a later attach,
 * and its chunks go to no socket.
 */
function closeAfterTurns(socket: WebSocketLike) {
  const closeHandlers: Array<() => void> = []
  let open = true
  let turns = 0
  const release = () => {
    if (open || turns > 0) return
    for (const handler of closeHandlers.splice(0)) handler()
  }
  const closed = () => {
    open = false
    release()
  }
  socket.addEventListener("close", closed)
  socket.addEventListener("error", closed)
  const kept: WebSocketLike = {
    send: (data) => {
      if (open) socket.send(data)
    },
    close: (code, reason) => socket.close(code, reason),
    addEventListener: ((
      type: "message" | "close" | "error",
      handler: (event: { data: unknown }) => void,
    ) => {
      if (type === "message") socket.addEventListener("message", handler)
      // An error also closes the socket, and the close stops the rest.
      else if (type === "close") closeHandlers.push(handler as () => void)
    }) as WebSocketLike["addEventListener"],
  }
  return {
    socket: kept,
    /** Count a turn until its run log closes. */
    track<TOffset extends string>(
      log: StreamDurability<TOffset>,
    ): StreamDurability<TOffset> {
      turns += 1
      return {
        ...log,
        close: async () => {
          try {
            await log.close()
          } finally {
            turns -= 1
            // The turn leaves `toWebSocketStream` after its log closes.
            setTimeout(release, 0)
          }
        },
      }
    },
  }
}

/**
 * Register a turn while it runs, so that an abort frame on any socket of
 * this user in this conversation stops it.
 */
async function* registeredTurn(
  key: string,
  stop: AbortController,
  turn: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  runningTurns.set(key, stop)
  try {
    yield* turn
  } finally {
    if (runningTurns.get(key) === stop) runningTurns.delete(key)
  }
}

/**
 * Start a turn or a resume on a chat socket. The run log key holds the
 * organization, the user, and the conversation of the socket. Thus a resume
 * finds only a run that the same user started in that conversation, and a
 * turn of another user cannot add chunks to that run log. Any other run
 * fails as an unknown run.
 *
 * A turn continues when its socket closes. An abort frame (the Stop control)
 * stops it, from the socket that started it or from a later socket of the
 * same user in the same conversation. A turn also stops after `maxTurnMs`, so
 * a hung turn does not keep its lock, sandbox lease and tokens.
 *
 * A join to a run that no turn of this process runs calls `endLostRun`
 * before the socket closes. A deploy or a crash can leave such a run marked
 * as running.
 */
export function startConversationChatSocket(
  socket: WebSocketLike,
  request: Request,
  scope: { orgId: string; userId: string; conversationId: string },
  onRun: ConversationChatSocketRun,
  options: {
    endLostRun?: (runId: string) => Promise<void>
    maxTurnMs?: number
    transport?: {
      resume: typeof resumeWebSocketStream
      stream: typeof toWebSocketStream
    }
  } = {},
) {
  const transport = options.transport ?? {
    resume: resumeWebSocketStream,
    stream: toWebSocketStream,
  }
  // Well above a long agent turn.
  const maxTurnMs = options.maxTurnMs ?? 2 * 60 * 60_000
  const runLog = (runId: string) =>
    `${scope.orgId}/${scope.userId}/${scope.conversationId}/${runId}`
  // A turn of any user in this conversation. The run log of another user
  // has a different key, so it is not in this socket's run log.
  const runsInThisProcess = (runId: string) =>
    [...runningTurns.keys()].some(
      (key) =>
        key.startsWith(`${scope.orgId}/`) &&
        key.endsWith(`/${scope.conversationId}/${runId}`),
    )
  socket.addEventListener("message", (event) => {
    const runId = abortFrameRunId(event.data)
    if (runId) runningTurns.get(runLog(runId))?.abort()
  })
  const query = new URL(request.url).searchParams
  const offset = query.get("offset")
  if (offset !== null) {
    const runId = query.get("runId")
    if (!runId) {
      socket.close(1011, "resume failed")
      return "resume" as const
    }
    const adapter = memoryStream({ runId: runLog(runId), offset })
    // A read of an unknown run from the start adds an empty run log entry.
    // When the socket closes before the first chunk, nothing removes that
    // entry. Thus close a run with no data before the read, with the same
    // close that the read gives.
    void adapter.snapshot().then(async (entries) => {
      if (entries.length > 0) {
        transport.resume(socket, { adapter })
        return
      }
      if (options.endLostRun && !runsInThisProcess(runId)) {
        try {
          await options.endLostRun(runId)
        } catch {
          // The socket closes as for an unknown run. A later join tries again.
        }
      }
      socket.close(1011, "resume failed")
    })
    return "resume" as const
  }
  const kept = closeAfterTurns(socket)
  transport.stream(kept.socket, request, {
    durability: (ctx) => kept.track(memoryStream({ runId: runLog(ctx.runId) })),
    onRun: (ctx) => {
      const stop = new AbortController()
      return registeredTurn(
        runLog(ctx.runId),
        stop,
        onRun({
          ...ctx,
          signal: AbortSignal.any([
            ctx.signal,
            stop.signal,
            AbortSignal.timeout(maxTurnMs),
          ]),
        }),
      )
    },
  })
  return "run" as const
}

type MessageHandler = (ev: { data: unknown }) => void
type CloseHandler = () => void

export type BunWebSocketLike = WebSocketLike & {
  dispatchMessage: (data: string) => void
  dispatchClose: () => void
  dispatchError: () => void
}

export function bunSocketToWebSocketLike(ws: {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}): BunWebSocketLike {
  const messageHandlers: MessageHandler[] = []
  const closeHandlers: CloseHandler[] = []
  const errorHandlers: CloseHandler[] = []
  return {
    send: (data) => {
      ws.send(data)
    },
    close: (code, reason) => {
      ws.close(code, reason)
    },
    addEventListener(type, handler) {
      if (type === "message") {
        messageHandlers.push(handler as MessageHandler)
        return
      }
      if (type === "close") {
        closeHandlers.push(handler as CloseHandler)
        return
      }
      errorHandlers.push(handler as CloseHandler)
    },
    dispatchMessage(data) {
      for (const handler of messageHandlers) handler({ data })
    },
    dispatchClose() {
      for (const handler of closeHandlers) handler()
    },
    dispatchError() {
      for (const handler of errorHandlers) handler()
    },
  }
}
