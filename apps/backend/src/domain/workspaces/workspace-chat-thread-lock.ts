import { defineChatMiddleware, type ModelMessage } from "@tanstack/ai"
import type { LockStore } from "@tanstack/ai/locks"
import type { MessageStore, RunStore } from "@tanstack/ai-persistence"

class ConversationChangedError extends Error {
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
 * The thread that chat persistence stores for a send: the stored messages up
 * to the newest one that the send also has, with the sent version of each
 * message, then the sent messages that the store does not have. A copy of
 * `mergeStoredMessages` in `@tanstack/ai-persistence` 0.7.1, which the package
 * does not export. The merge is not idempotent for a message without an id (a
 * tool result), thus the turn gives the merged thread to `chat()`: a merge of
 * the thread with itself gives the same thread.
 */
function mergeStoredMessages(
  stored: ReadonlyArray<ModelMessage>,
  incoming: ReadonlyArray<ModelMessage>,
): ModelMessage[] {
  if (incoming.length === 0) return [...stored]
  let cutoff = stored.length
  for (let index = incoming.length - 1; index >= 0; index--) {
    const id = incoming[index]?.id
    if (id === undefined) continue
    const storedIndex = stored.findIndex((message) => message.id === id)
    if (storedIndex >= 0) {
      cutoff = storedIndex + 1
      break
    }
  }
  const incomingById = new Map<string, ModelMessage>()
  for (const message of incoming)
    if (message.id) incomingById.set(message.id, message)
  const storedIds = new Set<string>()
  const merged: ModelMessage[] = []
  for (const message of stored.slice(0, cutoff)) {
    if (message.id) {
      storedIds.add(message.id)
      merged.push(incomingById.get(message.id) ?? message)
      continue
    }
    merged.push(message)
  }
  incoming.forEach((message, index) => {
    if (message.id) {
      if (!storedIds.has(message.id)) merged.push(message)
      return
    }
    const existing = merged[index]
    if (
      existing &&
      existing.id === undefined &&
      existing.role === message.role &&
      existing.content === message.content
    )
      return
    merged.push(message)
  })
  return merged
}

/**
 * Start a turn: take the conversation's lock for the whole run, then store
 * the question and a running run record. Call it before the runtime and
 * sandbox setup, which can take a minute. Thus a chat that opens again during
 * the setup shows the question and attaches to the run, and a turn that stops
 * during the setup keeps the question.
 *
 * The lock comes first, so two sends to one conversation never interleave
 * across replicas, and a queued send whose history no longer matches the
 * saved transcript is rejected instead of overwriting it.
 *
 * Give `messages` and `middleware` to `chat()`, the middleware before
 * `withPersistence`: it releases the lock when the run ends. If the turn
 * stops before `chat()` runs, call `stop`.
 */
export async function holdWorkspaceChatTurn(input: {
  locks: LockStore
  stores: { messages: MessageStore; runs: RunStore }
  threadId: string
  runId: string
  /** The messages that the turn gives to `chat()`, as model messages. */
  messages: ReadonlyArray<ModelMessage>
  /** Stops the turn when the lock's lease is lost. */
  onLost: () => void
}) {
  let release!: () => void
  const finished = new Promise<void>((resolve) => {
    release = resolve
  })
  let ready!: () => void
  const acquired = new Promise<void>((resolve) => {
    ready = resolve
  })
  const held = input.locks.withLock(
    `chat-thread:${input.threadId}`,
    async (signal) => {
      signal.addEventListener("abort", input.onLost, { once: true })
      try {
        signal.throwIfAborted()
        ready()
        await finished
      } finally {
        signal.removeEventListener("abort", input.onLost)
      }
    },
  )
  // A lost lease after the start surfaces through `onLost`.
  held.catch(() => undefined)
  let open = true
  const settle = async () => {
    if (!open) return
    open = false
    release()
    await held.catch(() => undefined)
  }

  await Promise.race([acquired, held])
  let thread: ModelMessage[]
  try {
    const { messages, runs } = input.stores
    const stored = await messages.loadThread(input.threadId)
    if (input.messages.length > 0) {
      const sent = questionIds(input.messages)
      if (questionIds(stored).some((id, index) => id !== sent[index]))
        throw new ConversationChangedError()
    }
    await runs.createOrResume({
      runId: input.runId,
      threadId: input.threadId,
      startedAt: Date.now(),
    })
    thread = mergeStoredMessages(stored, input.messages)
    if (input.messages.length > 0)
      await messages.saveThread(input.threadId, thread)
  } catch (error) {
    await settle()
    throw error
  }

  return {
    /** The stored thread with the question: the messages for `chat()`. */
    messages: thread,
    middleware: defineChatMiddleware({
      name: "workspace-chat-thread-lock",
      onFinish: settle,
      onError: settle,
      onAbort: settle,
    }),
    /**
     * End the run of a turn that stopped before `chat()`, then release. A
     * stop by the user or a lost lease is `aborted`, other errors `failed`.
     */
    async stop(error: unknown, aborted = false) {
      if (!open) return
      try {
        await input.stores.runs.update(input.runId, {
          finishedAt: Date.now(),
          ...(aborted
            ? { status: "aborted" }
            : {
                status: "failed",
                error: {
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              }),
        })
      } finally {
        await settle()
      }
    },
  }
}
