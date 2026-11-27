import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { chat, modelMessagesToUIMessages, type Tool } from "@tanstack/ai"
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence"
import { fakeText } from "@tanstack/ai/testing"
import { config } from "dotenv"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  chatInterrupts,
  chatRuns,
  chatThreads,
} from "../../db/schema/chat-persistence.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"

/**
 * Chats that TanStack AI 0.63.0 and ai-persistence 0.7.1 stored, read and
 * resumed by TanStack AI 1.x (CTX-1580). The records below are what 0.63.0
 * wrote for a scripted model: one finished turn with a tool call and
 * reasoning, and one turn that paused on a tool approval. Only the ids carry
 * a per-run suffix, because the tables key on them.
 */

config({
  path: resolve(import.meta.dirname, "../../../.env.local"),
  quiet: true,
})

const runKey = `chatv0_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const org = { id: `${runKey}_org`, slug: `${runKey}-org`, name: "Chat v0 org" }
const workspaceId = `ws_${runKey}`
const doneThread = `conv_${runKey}_done`
const pausedThread = `conv_${runKey}_paused`
const pausedRun = `run_${runKey}_paused`
const approvalId = `approval_${runKey}`
const toolCallId = `call_${runKey}`
const unboundId = `unbound_${runKey}`

/** The migration that cancels the pending interrupts 1.x cannot resume. */
const cancelUnbound = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../migrations/20261126233844_cancel_unbound_chat_interrupts/migration.sql",
  ),
  "utf8",
)

/**
 * A finished 0.63.0 turn: reasoning, a tool call, its result, an answer. The
 * rows are JSON, as `chat_threads.messages_json` holds them.
 */
const doneTranscript: unknown[] = [
  { role: "user", content: "What is in the README?" },
  {
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: "call-read",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      },
    ],
    id: "msg-1795736522773-xpl0rfb",
    createdAt: "2026-11-26T23:42:02.773Z",
    thinking: [{ content: "Look up the file first." }],
    metadata: { tanstack: { run: { id: "run_fixture_done" } } },
  },
  {
    role: "tool",
    content: '{"content":"# Title"}',
    toolCallId: "call-read",
  },
  {
    role: "assistant",
    content: "The README has one heading.",
    id: "msg-d2",
    createdAt: "2026-11-26T23:42:02.776Z",
    metadata: { tanstack: { run: { id: "run_fixture_done" } } },
  },
]

/** A 0.63.0 turn that stopped for the approval of `publish_change`. */
const pausedTranscript: unknown[] = [
  { role: "user", content: "Publish the docs update." },
  {
    role: "assistant",
    content: "I will publish the change.",
    toolCalls: [
      {
        id: toolCallId,
        type: "function",
        function: {
          name: "publish_change",
          arguments: '{"branch":"docs/update"}',
        },
      },
    ],
    id: "msg-a1",
    createdAt: "2026-11-26T23:41:22.289Z",
    metadata: { tanstack: { run: { id: pausedRun } } },
  },
]

/** The interrupt payload 0.63.0 wrote for that approval, with its binding. */
const approvalPayload = {
  id: approvalId,
  reason: "tool_call",
  message: "Approval required to run publish_change",
  toolCallId,
  responseSchema: {
    oneOf: [
      {
        type: "object",
        properties: {
          approved: { const: true },
          editedArgs: {
            type: "object",
            properties: { branch: { type: "string" } },
            required: ["branch"],
          },
        },
        required: ["approved"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { approved: { const: false } },
        required: ["approved"],
        additionalProperties: false,
      },
    ],
  },
  metadata: {
    kind: "approval",
    toolName: "publish_change",
    input: { branch: "docs/update" },
    "tanstack:interruptBinding": {
      v: 1,
      kind: "tool-approval",
      interruptId: approvalId,
      toolName: "publish_change",
      toolCallId,
      originalArgs: { branch: "docs/update" },
      inputSchemaHash:
        "sha256:5eb95e25d2dd87cc4aef830fb2165c117af6308398d2f3617858c3d5112929ed",
      approvalSchemaHash:
        "sha256:22f76d9a1c618a3cfaa891208a14f6e5e6ab1be4ff1c38cc8a8cd1e8fd0c0e4e",
      responseSchemaHash:
        "sha256:9ce426f7f68aed249c815ef468d014775269eaccc3341c8358125918428cc683",
      interruptedRunId: pausedRun,
      generation: 0,
    },
  },
}

/** The tool of the paused turn, as the 0.63.0 run defined it. */
function publishChange(executed: string[]): Tool {
  return {
    name: "publish_change",
    description: "Publish a change",
    inputSchema: {
      type: "object",
      properties: { branch: { type: "string" } },
      required: ["branch"],
    },
    needsApproval: true,
    execute: async (args: { branch: string }) => {
      executed.push(args.branch)
      return { published: args.branch }
    },
  }
}

const asOrg = <T>(run: () => Promise<T>) =>
  withOrgIdContext({ id: org.id, slug: org.slug }, run)

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl)
    throw new Error(
      "DATABASE_URL is required; run pnpm --filter @ctxpipe/backend test against a migrated Postgres",
    )
  initDb(databaseUrl)
  await getSystemDb().insert(organizations).values({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: new Date(),
  })
  await withOrgDbContext(org.id, async (db) => {
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId: org.id,
      slug: `ws-${runKey}`,
      displayName: "Chat v0 workspace",
      workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${runKey}`,
    })
    await db.insert(conversations).values([
      { id: doneThread, orgId: org.id, name: "Done", workspaceId },
      { id: pausedThread, orgId: org.id, name: "Paused", workspaceId },
    ])
    // The rows as 0.7.1 left them, written past the 1.x stores.
    await db.insert(chatThreads).values([
      {
        threadId: doneThread,
        orgId: org.id,
        messagesJson: doneTranscript,
        updatedAt: 1795736522776,
      },
      {
        threadId: pausedThread,
        orgId: org.id,
        messagesJson: pausedTranscript,
        updatedAt: 1795736482291,
      },
    ])
    await db.insert(chatRuns).values({
      runId: pausedRun,
      threadId: pausedThread,
      orgId: org.id,
      status: "interrupted",
      startedAt: 1795736482289,
    })
    await db.insert(chatInterrupts).values({
      interruptId: approvalId,
      runId: pausedRun,
      threadId: pausedThread,
      orgId: org.id,
      status: "pending",
      requestedAt: 1795736482291,
      payloadJson: approvalPayload,
    })
  })
})

afterAll(async () => {
  try {
    await withOrgDbContext(org.id, async (db) => {
      for (const threadId of [doneThread, pausedThread]) {
        await db
          .delete(chatInterrupts)
          .where(eq(chatInterrupts.threadId, threadId))
        await db.delete(chatRuns).where(eq(chatRuns.threadId, threadId))
        await db.delete(chatThreads).where(eq(chatThreads.threadId, threadId))
        await db.delete(conversations).where(eq(conversations.id, threadId))
      }
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
  } finally {
    await closeDb()
  }
})

describe("a chat that TanStack AI 0.63.0 stored", () => {
  it("loads a finished turn as the same messages and UI parts", async () => {
    const loaded = await asOrg(() =>
      workspaceChatPersistence().stores.messages.loadThread(doneThread),
    )
    // The store revives `createdAt` as a Date; the rest is the stored JSON.
    expect(loaded[1]?.createdAt).toBeInstanceOf(Date)
    expect(JSON.parse(JSON.stringify(loaded))).toEqual(doneTranscript)
    // 0.63.0 gave the same messages and parts for these rows: an answer
    // with its own id stays its own UI message.
    const ui = modelMessagesToUIMessages(loaded)
    expect(ui.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ])
    expect(ui[1]?.parts).toEqual([
      expect.objectContaining({
        type: "thinking",
        content: "Look up the file first.",
      }),
      expect.objectContaining({
        type: "tool-call",
        id: "call-read",
        name: "read_file",
        state: "complete",
      }),
      expect.objectContaining({
        type: "tool-result",
        toolCallId: "call-read",
        content: '{"content":"# Title"}',
      }),
    ])
    expect(ui[2]?.parts).toEqual([
      expect.objectContaining({
        type: "text",
        content: "The README has one heading.",
      }),
    ])
  })

  it("hydrates the paused turn with its pending approval", async () => {
    const response = await asOrg(() =>
      reconstructChat(
        workspaceChatPersistence(),
        new Request(`http://localhost/?threadId=${pausedThread}`),
      ),
    )
    const body = (await response.json()) as {
      activeRun: unknown
      interrupts: { runId: string; pending: Array<{ id?: string }> } | null
      messages: Array<{ role: string; parts: Array<{ type: string }> }>
    }
    expect(body.activeRun).toBeNull()
    expect(body.interrupts?.runId).toBe(pausedRun)
    expect(body.interrupts?.pending.map((item) => item.id)).toEqual([
      approvalId,
    ])
    expect(body.messages.at(-1)?.parts).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "tool-call", name: "publish_change" }),
    ])
  })

  it("resumes the paused approval and finishes the turn", async () => {
    const executed: string[] = []
    // The subject is the stored chat, not a model provider: the stock fake
    // model of TanStack AI answers the resumed turn.
    const model = fakeText()
    model.setResponses([{ text: "Published." }])
    await asOrg(async () => {
      const persistence = workspaceChatPersistence()
      const messages =
        await persistence.stores.messages.loadThread(pausedThread)
      const types: string[] = []
      for await (const chunk of chat({
        adapter: model,
        threadId: pausedThread,
        runId: `run_${runKey}_resume`,
        messages,
        tools: [publishChange(executed)],
        middleware: [withPersistence(persistence)],
        resume: [
          {
            interruptId: approvalId,
            status: "resolved",
            payload: { approved: true },
          },
        ],
      }))
        types.push(chunk.type)
      expect(types).not.toContain("RUN_ERROR")
      expect(types.at(-1)).toBe("RUN_FINISHED")
      expect(executed).toEqual(["docs/update"])
      expect(await persistence.stores.interrupts.get(approvalId)).toEqual(
        expect.objectContaining({
          status: "resolved",
          response: { approved: true },
        }),
      )
      const after = await persistence.stores.messages.loadThread(pausedThread)
      expect(after.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "Publish the docs update." },
        { role: "assistant", content: "I will publish the change." },
        { role: "tool", content: '{"published":"docs/update"}' },
        { role: "assistant", content: "Published." },
      ])
    })
  })

  it("cancels only the pending interrupts that have no binding, once", async () => {
    // An approval with no binding, which 1.x cannot resume.
    const { "tanstack:interruptBinding": _binding, ...unboundMetadata } =
      approvalPayload.metadata
    await withOrgDbContext(org.id, async (db) => {
      await db.insert(chatInterrupts).values({
        interruptId: unboundId,
        runId: pausedRun,
        threadId: pausedThread,
        orgId: org.id,
        status: "pending",
        requestedAt: 1795736482292,
        payloadJson: {
          ...approvalPayload,
          id: unboundId,
          metadata: unboundMetadata,
        },
      })
    })
    const statuses = () =>
      withOrgDbContext(org.id, async (db) =>
        Object.fromEntries(
          (
            await db
              .select({
                id: chatInterrupts.interruptId,
                status: chatInterrupts.status,
              })
              .from(chatInterrupts)
              .where(eq(chatInterrupts.threadId, pausedThread))
          ).map((row) => [row.id, row.status]),
        ),
      )
    const before = await statuses()
    // The test role sees only this organization's rows, so the run changes
    // no other test's rows.
    await withOrgDbContext(org.id, (db) => db.execute(sql.raw(cancelUnbound)))
    const after = await statuses()
    expect(after).toEqual({ ...before, [unboundId]: "cancelled" })
    await withOrgDbContext(org.id, (db) => db.execute(sql.raw(cancelUnbound)))
    expect(await statuses()).toEqual(after)
  })
})
