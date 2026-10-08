import {
  convertMessagesToModelMessages,
  defineChatMiddleware,
  type ModelMessage,
  modelMessagesToUIMessages,
} from "@tanstack/ai"
import type { LockStore } from "@tanstack/ai/locks"

export class ConversationChangedError extends Error {
  constructor() {
    super("Conversation changed during another send; reload before retrying")
  }
}

/**
 * Persisted message content after the UI round trip, ignoring ids, times and
 * metadata. Persistence adds the run id to the metadata of a stored answer,
 * and a browser that streamed that answer does not have it.
 */
function transcriptContent(messages: ReadonlyArray<ModelMessage>): string {
  const normalized = convertMessagesToModelMessages(
    modelMessagesToUIMessages([...messages]),
  ).map(
    ({ id: _id, createdAt: _createdAt, metadata: _metadata, ...message }) =>
      message,
  )
  return JSON.stringify(normalized, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    )
  })
}

/**
 * Hold the conversation's lock for the whole run, so two sends to one
 * conversation never interleave across replicas. A queued send whose history
 * no longer matches the saved transcript is rejected instead of overwriting it.
 * Place before `withPersistence`.
 */
export function workspaceChatThreadLock(input: {
  locks: LockStore
  loadThread: (threadId: string) => Promise<ReadonlyArray<ModelMessage>>
}) {
  let release: (() => void) | undefined
  let held: Promise<void> | undefined
  let validated = false

  const settle = async () => {
    const pending = held
    release?.()
    release = undefined
    held = undefined
    try {
      await pending
    } catch {
      // The run already ended; a lost lease surfaced through the abort signal.
    }
  }

  return defineChatMiddleware({
    name: "workspace-chat-thread-lock",
    async setup(ctx) {
      let ready!: () => void
      let failed!: (error: unknown) => void
      const acquired = new Promise<void>((resolve, reject) => {
        ready = resolve
        failed = reject
      })
      const finished = new Promise<void>((resolve) => {
        release = resolve
      })
      held = input.locks.withLock(
        `chat-thread:${ctx.threadId}`,
        async (signal) => {
          const lost = () => {
            if (!ctx.signal?.aborted)
              ctx.abort("Chat thread lock ownership lost")
          }
          signal.addEventListener("abort", lost, { once: true })
          try {
            signal.throwIfAborted()
            ready()
            await finished
          } finally {
            signal.removeEventListener("abort", lost)
          }
        },
      )
      held.catch(failed)
      await acquired
    },
    async onConfig(ctx, config) {
      if (validated) return
      validated = true
      if (config.messages.length === 0) return
      const stored = await input.loadThread(ctx.threadId)
      if (
        transcriptContent(
          (config.messages as ModelMessage[]).slice(0, stored.length),
        ) !== transcriptContent(stored)
      )
        throw new ConversationChangedError()
    },
    onFinish: settle,
    onError: settle,
    onAbort: settle,
  })
}
