import { resolve } from "node:path"

import { chat, type ModelMessage, type StreamChunk } from "@tanstack/ai"
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence"
import { BaseTextAdapter } from "@tanstack/ai/adapters"
import type { LockStore } from "@tanstack/ai/locks"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { chatRuns, chatThreads } from "../../db/schema/chat-persistence.js"
import { conversations } from "../../db/schema/conversations.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"
import { holdWorkspaceChatTurn } from "./workspace-chat-thread-lock.js"

config({
  path: resolve(import.meta.dirname, "../../../.env.local"),
  quiet: true,
})

const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const org = { id: `org_turnhold_${suffix}`, slug: `turnhold-${suffix}` }
const conversationIds: string[] = []

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  await getSystemDb()
    .insert(organizations)
    .values({ ...org, name: "Turn hold org", createdAt: new Date() })
})

afterAll(async () => {
  try {
    await withOrgDbContext(org.id, async (db) => {
      for (const id of conversationIds) {
        await db.delete(chatRuns).where(eq(chatRuns.threadId, id))
        await db.delete(chatThreads).where(eq(chatThreads.threadId, id))
        await db.delete(conversations).where(eq(conversations.id, id))
      }
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
  } finally {
    await closeDb()
  }
})

async function newConversation() {
  const id = `conv_turnhold_${suffix}_${conversationIds.length}`
  conversationIds.push(id)
  await withOrgDbContext(org.id, (db) =>
    db.insert(conversations).values({ id, orgId: org.id, name: "Turn hold" }),
  )
  return id
}

/** The model is the environment: it answers each call with one text. */
class AnswerModel extends BaseTextAdapter<string, never, [], never> {
  readonly name = "answer"
  constructor() {
    super({}, "answer/model")
  }
  async *chatStream(options: { runId?: string; threadId?: string }) {
    const run = { runId: options.runId, threadId: options.threadId }
    const timestamp = Date.now()
    const messageId = `answer-${options.runId}`
    yield { type: "RUN_STARTED", ...run, timestamp } as never
    for (const chunk of [
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "Answer" },
      { type: "TEXT_MESSAGE_END", messageId },
    ])
      yield { model: "answer/model", timestamp, ...chunk } as never
    yield {
      type: "RUN_FINISHED",
      ...run,
      finishReason: "stop",
      timestamp,
    } as never
  }
  async structuredOutput(): Promise<never> {
    throw new Error("Not used")
  }
}

/**
 * One turn as the backend runs it: hold the conversation first, then the
 * runtime and sandbox setup (`setup`, which the test controls), then `chat()`.
 * The test can watch the lock (`locks`) and the stored thread (`stores`).
 */
async function turn(
  threadId: string,
  runId: string,
  messages: ModelMessage[],
  options: {
    setup?: Promise<void>
    locks?: (store: LockStore) => LockStore
    stores?: (
      stores: ReturnType<typeof workspaceChatPersistence>["stores"],
    ) => ReturnType<typeof workspaceChatPersistence>["stores"]
  } = {},
) {
  const abort = new AbortController()
  const base = workspaceChatPersistence({ threadId })
  const persistence = {
    ...base,
    stores: options.stores?.(base.stores) ?? base.stores,
  }
  const locks = postgresSandboxLocks(org.id, abort)
  const held = await holdWorkspaceChatTurn({
    locks: options.locks?.(locks) ?? locks,
    stores: persistence.stores,
    threadId,
    runId,
    messages,
    onLost: () => abort.abort("lost"),
  })
  await options.setup
  for await (const _ of chat({
    adapter: new AnswerModel(),
    threadId,
    runId,
    messages: held.messages,
    abortController: abort,
    middleware: [withPersistence(persistence), held.middleware],
  }) as AsyncIterable<StreamChunk>);
}

/** What a reopened chat reads: `GET /conversations/:id/chat`. */
async function reopen(threadId: string) {
  const response = await reconstructChat(
    workspaceChatPersistence(),
    new Request(`http://chat.test/reconstruct?threadId=${threadId}`),
    { authorize: async (id) => id === threadId },
  )
  const body = (await response.json()) as {
    messages: Array<{ id: string; role: string }>
    activeRun: { runId: string } | null
  }
  return {
    ids: body.messages.map((message) => message.id),
    activeRun: body.activeRun?.runId ?? null,
  }
}

/** A lock store that tells when a turn asks for the lock and holds it. */
function watchedLocks() {
  const state = { asked: false, held: false, released: false }
  let asked!: () => void
  const askedLock = new Promise<void>((resolve) => {
    asked = resolve
  })
  const wrap = (store: LockStore): LockStore =>
    Object.assign(Object.create(store), {
      withLock: (
        key: string,
        fn: (signal: AbortSignal) => Promise<unknown>,
      ) => {
        state.asked = true
        asked()
        return store.withLock(key, async (signal) => {
          state.held = true
          try {
            return await fn(signal)
          } finally {
            state.released = true
          }
        })
      },
    })
  return { state, askedLock, wrap }
}

const question = (id: string): ModelMessage => ({
  id,
  role: "user",
  content: `Question ${id}`,
})

it("shows the question and the running run while the turn setup is slow", async () => {
  await withOrgIdContext(org, async () => {
    const threadId = await newConversation()
    let setupDone!: () => void
    const setup = new Promise<void>((resolve) => {
      setupDone = resolve
    })
    const running = turn(threadId, `${threadId}-r1`, [question("q1")], {
      setup,
    })
    await expect
      .poll(() => reopen(threadId))
      .toEqual({
        ids: ["q1"],
        activeRun: `${threadId}-r1`,
      })
    setupDone()
    await running
    expect(await reopen(threadId)).toEqual({
      ids: ["q1", `answer-${threadId}-r1`],
      activeRun: null,
    })
  })
})

it("keeps both transcripts when a second turn is sent while the first still holds the conversation", async () => {
  await withOrgIdContext(org, async () => {
    const threadId = await newConversation()
    let firstSetupDone!: () => void
    const firstSetup = new Promise<void>((resolve) => {
      firstSetupDone = resolve
    })
    const first = turn(threadId, `${threadId}-r1`, [question("q1")], {
      setup: firstSetup,
    })
    await expect
      .poll(() => reopen(threadId))
      .toEqual({
        ids: ["q1"],
        activeRun: `${threadId}-r1`,
      })
    const answer: ModelMessage = {
      id: `answer-${threadId}-r1`,
      role: "assistant",
      content: "Answer",
    }
    const watched = watchedLocks()
    const second = turn(
      threadId,
      `${threadId}-r2`,
      [question("q1"), answer, question("q2")],
      { locks: watched.wrap },
    )
    // The second turn asks for the lock, which the first holds: it stores
    // nothing yet.
    await watched.askedLock
    expect(watched.state.held).toBe(false)
    expect((await reopen(threadId)).ids).toEqual(["q1"])

    firstSetupDone()
    await Promise.all([first, second])
    expect(await reopen(threadId)).toEqual({
      ids: ["q1", answer.id, "q2", `answer-${threadId}-r2`],
      activeRun: null,
    })
  })
})

it("fails the run and keeps the question when the turn stops before the chat starts", async () => {
  await withOrgIdContext(org, async () => {
    const threadId = await newConversation()
    const persistence = workspaceChatPersistence({ threadId })
    const held = await holdWorkspaceChatTurn({
      locks: postgresSandboxLocks(org.id),
      stores: persistence.stores,
      threadId,
      runId: `${threadId}-r1`,
      messages: [question("q1")],
      onLost: () => undefined,
    })
    await held.failRun(new Error("Sandbox setup failed"))
    expect(await reopen(threadId)).toEqual({ ids: ["q1"], activeRun: null })
    expect(await persistence.stores.runs.get(`${threadId}-r1`)).toMatchObject({
      status: "failed",
      error: { message: "Sandbox setup failed" },
    })
    // The lock is free again: the next turn starts.
    await turn(threadId, `${threadId}-r2`, [question("q1"), question("q2")])
    expect((await reopen(threadId)).ids).toEqual([
      "q1",
      "q2",
      `answer-${threadId}-r2`,
    ])
  })
})

type Stores = ReturnType<typeof workspaceChatPersistence>["stores"]

/** The stores with a step that runs around each thread save. */
const aroundSave =
  (around: (save: () => Promise<void>) => Promise<void>) =>
  (stores: Stores): Stores => ({
    ...stores,
    messages: Object.assign(Object.create(stores.messages), {
      saveThread: (id: string, thread: ModelMessage[]) =>
        around(() => stores.messages.saveThread(id, thread)),
    }),
  })

it("keeps the next question while the next turn sets up after a turn ends", async () => {
  await withOrgIdContext(org, async () => {
    const threadId = await newConversation()
    const answer: ModelMessage = {
      id: `answer-${threadId}-r1`,
      role: "assistant",
      content: "Answer",
    }
    let secondSetupDone!: () => void
    const secondSetup = new Promise<void>((resolve) => {
      secondSetupDone = resolve
    })
    let secondSaved!: () => void
    const secondSavedThread = new Promise<void>((resolve) => {
      secondSaved = resolve
    })
    let second: Promise<void> | undefined
    const startSecond = () => {
      second ??= turn(
        threadId,
        `${threadId}-r2`,
        [question("q1"), answer, question("q2")],
        {
          setup: secondSetup,
          stores: aroundSave(async (save) => {
            await save()
            secondSaved()
          }),
        },
      )
      return second
    }
    const firstLock = watchedLocks()
    await turn(threadId, `${threadId}-r1`, [question("q1")], {
      locks: firstLock.wrap,
      // If the first turn frees the lock before its final save, the second
      // turn stores its question first, and the final save then removes it.
      stores: aroundSave(async (save) => {
        if (firstLock.state.released) {
          void startSecond()
          await secondSavedThread
        }
        await save()
      }),
    })
    void startSecond()
    // The second turn is in its setup: a reopen shows its question.
    await expect
      .poll(() => reopen(threadId))
      .toEqual({
        ids: ["q1", answer.id, "q2"],
        activeRun: `${threadId}-r2`,
      })
    secondSetupDone()
    await second
  })
})
