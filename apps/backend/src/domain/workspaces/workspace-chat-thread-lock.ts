import { defineChatMiddleware, type ModelMessage } from "@tanstack/ai"
import type { LockStore } from "@tanstack/ai/locks"

export class ConversationChangedError extends Error {
  constructor() {
    super("Conversation changed during another send; reload before retrying")
  }
}

/**
 * The ids of the user messages, in order. The browser and the store keep
 * different shapes for the same answer (one message per text part or a
 * separate tool message in the browser, one merged message in the store, and
 * metadata only in the store). The questions keep their ids, thus a send is
 * stale when its history does not start with the stored questions.
 */
function questionIds(messages: ReadonlyArray<ModelMessage>): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.id ?? "")
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
      const stored = questionIds(await input.loadThread(ctx.threadId))
      const sent = questionIds(config.messages as ModelMessage[])
      if (stored.some((id, index) => id !== sent[index]))
        throw new ConversationChangedError()
    },
    onFinish: settle,
    onError: settle,
    onAbort: settle,
  })
}
