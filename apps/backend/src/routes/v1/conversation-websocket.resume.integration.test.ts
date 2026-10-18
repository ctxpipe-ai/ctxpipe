import { randomUUID } from "node:crypto"
import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { getSystemDb, initDb, withOrgDbContext } from "../../db/client.js"
import { members } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import { generateObjectId } from "../../lib/id.js"
import {
  type ConversationWebSocketData,
  conversationWebSocketHandlers,
  handleConversationWebSocket,
} from "./conversation-websocket.js"

const env = {
  AUTH_BASE_URL: "https://app.example.test",
  AUTH_ALLOWED_ORIGINS: "",
}
const now = new Date("2026-10-01T00:00:00.000Z")

type Socket = {
  ws: {
    data: ConversationWebSocketData
    readyState: number
    send: (data: string) => void
    close: (code?: number, reason?: string) => void
  }
  chunks: Array<{ type: string }>
  closed: Promise<{ code?: number; reason?: string }>
  runEnded: Promise<void>
}

/**
 * Opens a chat socket through the production upgrade handler and socket
 * handlers. Only the transport between the browser and Bun is left out.
 */
async function openSocket(
  seed: SeededOrg,
  conversationId: string,
  query = "",
): Promise<{ status: number } | Socket> {
  let data: ConversationWebSocketData | undefined
  const response = await handleConversationWebSocket(
    new Request(
      `${env.AUTH_BASE_URL}/${seed.orgSlug}/api/v1/conversations/${conversationId}${query}`,
      {
        headers: {
          upgrade: "websocket",
          origin: env.AUTH_BASE_URL,
          cookie: seed.cookie,
        },
      },
    ),
    {
      upgrade: (_request, options) => {
        data = options.data
        return true
      },
    },
    env,
  )
  if (response) return { status: response.status }
  if (!data) throw new Error("the upgrade handler did not upgrade")
  const chunks: Array<{ type: string }> = []
  let onClose!: (value: { code?: number; reason?: string }) => void
  const closed = new Promise<{ code?: number; reason?: string }>((resolve) => {
    onClose = resolve
  })
  let onRunEnd!: () => void
  const runEnded = new Promise<void>((resolve) => {
    onRunEnd = resolve
  })
  const ws = {
    data,
    readyState: 1,
    send(raw: string) {
      const frame = JSON.parse(raw) as { chunk?: { type: string } }
      if (!frame.chunk) return
      chunks.push(frame.chunk)
      if (
        frame.chunk.type === "RUN_ERROR" ||
        frame.chunk.type === "RUN_FINISHED"
      )
        onRunEnd()
    },
    close(code?: number, reason?: string) {
      onClose({ code, reason })
    },
  }
  conversationWebSocketHandlers.open(ws)
  return { ws, chunks, closed, runEnded }
}

function upgraded(socket: { status: number } | Socket): Socket {
  if ("status" in socket) {
    throw new Error(`the upgrade returned ${socket.status}`)
  }
  return socket
}

/** Sends one turn frame on a turn socket and waits for the end of the run. */
async function sendTurn(
  socket: Socket,
  conversationId: string,
  runId: string,
): Promise<void> {
  conversationWebSocketHandlers.message(
    socket.ws,
    JSON.stringify({
      threadId: conversationId,
      runId,
      messages: [{ id: "user-1", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { source: "ui" },
    }),
  )
  await socket.runEnded
}

/** Resumes `runId` from the start and returns the replayed chunk types. */
async function replay(
  seed: SeededOrg,
  conversationId: string,
  runId: string,
): Promise<{ status: number } | { chunks: string[] }> {
  const socket = await openSocket(
    seed,
    conversationId,
    `?runId=${encodeURIComponent(runId)}&offset=-1`,
  )
  if ("status" in socket) return { status: socket.status }
  await socket.closed
  conversationWebSocketHandlers.close(socket.ws)
  return { chunks: socket.chunks.map((chunk) => chunk.type) }
}

describe("workspace chat socket resume", () => {
  let owner: SeededOrg | undefined
  let other: SeededOrg | undefined
  // A second user who is also a member of the owner's organization.
  let member: SeededOrg | undefined
  const ownConversation = generateObjectId("conv")
  const secondOwnConversation = generateObjectId("conv")
  const otherConversation = generateObjectId("conv")
  const runId = `run-${randomUUID()}`
  let runSocket: Socket | undefined

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    owner = await seedOrg()
    other = await seedOrg()
    member = await seedOrg()
    await getSystemDb()
      .insert(members)
      .values({
        id: generateObjectId("member"),
        organizationId: owner.orgId,
        userId: member.userId,
        role: "member",
        createdAt: now,
      })
    const ownerSeed = owner
    await withOrgDbContext(ownerSeed.orgId, async (db) => {
      await db.insert(conversations).values(
        [ownConversation, secondOwnConversation].map((id) => ({
          id,
          orgId: ownerSeed.orgId,
          userId: ownerSeed.userId,
          name: "Resume conversation",
          source: "ui",
          lastMessageAt: now,
        })),
      )
    })
    const otherSeed = other
    await withOrgDbContext(otherSeed.orgId, async (db) => {
      await db.insert(conversations).values({
        id: otherConversation,
        orgId: otherSeed.orgId,
        userId: otherSeed.userId,
        name: "Other org conversation",
        source: "ui",
        lastMessageAt: now,
      })
    })

    // One turn in the owner's conversation. It has no Workspace, so the
    // turn ends at once with a run error; its run log keeps that chunk.
    runSocket = upgraded(await openSocket(ownerSeed, ownConversation))
    await sendTurn(runSocket, ownConversation, runId)
  })

  afterAll(async () => {
    if (runSocket) conversationWebSocketHandlers.close(runSocket.ws)
    const seeds = [owner, other, member].filter((seed): seed is SeededOrg =>
      Boolean(seed),
    )
    if (seeds.length === 0) return
    await getSystemDb()
      .delete(conversations)
      .where(
        inArray(
          conversations.orgId,
          seeds.map((seed) => seed.orgId),
        ),
      )
    for (const seed of seeds) {
      // cleanupSeededOrg closes the pool, so open it again for the next seed.
      initDb(process.env.DATABASE_URL ?? "")
      await cleanupSeededOrg(seed)
    }
  })

  it("replays a run in the conversation that ran it", async () => {
    if (!owner) throw new Error("seedOrg did not run")
    expect(await replay(owner, ownConversation, runId)).toEqual({
      chunks: expect.arrayContaining(["RUN_ERROR"]),
    })
  })

  it("replays nothing for a run of another conversation of the same user", async () => {
    if (!owner) throw new Error("seedOrg did not run")
    expect(await replay(owner, secondOwnConversation, runId)).toEqual({
      chunks: [],
    })
  })

  it("replays nothing for a run of a conversation in another organization", async () => {
    if (!other) throw new Error("seedOrg did not run")
    expect(await replay(other, otherConversation, runId)).toEqual({
      chunks: [],
    })
  })

  it("refuses a resume of a conversation that the user cannot read, as not found", async () => {
    if (!other) throw new Error("seedOrg did not run")
    expect(await replay(other, ownConversation, runId)).toEqual({
      status: 404,
    })
  })

  it("accepts the first turn of a conversation that does not exist yet", async () => {
    if (!owner) throw new Error("seedOrg did not run")
    // A warmed socket opens before the turn creates its conversation.
    const newConversation = generateObjectId("conv")
    const socket = upgraded(await openSocket(owner, newConversation))
    try {
      await sendTurn(socket, newConversation, `run-${randomUUID()}`)
      expect(socket.chunks.map((chunk) => chunk.type)).toContain("RUN_ERROR")
    } finally {
      conversationWebSocketHandlers.close(socket.ws)
    }
  })

  it("keeps a turn of another member of the organization out of the run log", async () => {
    if (!owner || !member) throw new Error("seedOrg did not run")
    const before = await replay(owner, ownConversation, runId)
    expect(before).toEqual({ chunks: expect.arrayContaining(["RUN_ERROR"]) })
    const intruder = upgraded(
      await openSocket(
        { ...member, orgId: owner.orgId, orgSlug: owner.orgSlug },
        ownConversation,
      ),
    )
    try {
      await sendTurn(intruder, ownConversation, runId)
    } finally {
      conversationWebSocketHandlers.close(intruder.ws)
    }
    expect(await replay(owner, ownConversation, runId)).toEqual(before)
  })
})
