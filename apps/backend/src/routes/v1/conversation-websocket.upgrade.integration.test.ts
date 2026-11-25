import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { getSystemDb } from "../../db/client.js"
import { members, sessions, users } from "../../db/schema/auth.js"
import {
  type ConversationWebSocketData,
  conversationWebSocketHandlers,
  handleConversationWebSocket,
} from "./conversation-websocket.js"

let seed: SeededOrg | undefined
const env = {
  AUTH_BASE_URL: "https://app.example.test",
  AUTH_ALLOWED_ORIGINS: "https://ui.example.test",
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for this integration test")
  seed = await seedOrg()
})

afterAll(async () => {
  if (seed) await cleanupSeededOrg(seed)
})

/** The upgrade of a chat socket, through a server that records each upgrade. */
async function upgrade(headers: Record<string, string>) {
  if (!seed) throw new Error("seedOrg did not run")
  const upgrades: ConversationWebSocketData[] = []
  const response = await handleConversationWebSocket(
    new Request(
      `https://app.example.test/${seed.orgSlug}/api/v1/conversations/conv_upgrade`,
      { headers: { upgrade: "websocket", ...headers } },
    ),
    {
      upgrade: (_request, options) => {
        upgrades.push(options.data)
        return true
      },
    },
    env,
  )
  return {
    status: response?.status,
    upgraded: upgrades.length === 1,
    data: upgrades[0],
  }
}

const setBanned = (banned: boolean) =>
  getSystemDb()
    .update(users)
    .set({ banned })
    .where(eq(users.id, seed?.userId ?? ""))

it("upgrades a signed-in chat socket from AUTH_BASE_URL or an allowed origin", async () => {
  for (const origin of [env.AUTH_BASE_URL, "https://ui.example.test"]) {
    expect(await upgrade({ cookie: seed?.cookie ?? "", origin })).toMatchObject(
      { status: undefined, upgraded: true },
    )
  }
})

it("refuses a chat socket from another origin or with no origin", async () => {
  for (const headers of <Record<string, string>[]>[
    { cookie: seed?.cookie ?? "", origin: "https://other.example.test" },
    { cookie: seed?.cookie ?? "", origin: "null" },
    { cookie: seed?.cookie ?? "" },
  ]) {
    expect(await upgrade(headers)).toMatchObject({
      status: 403,
      upgraded: false,
    })
  }
})

it("refuses a chat socket that a personal API key opens", async () => {
  expect(
    await upgrade({
      "x-api-key": seed?.personalApiKey ?? "",
      origin: env.AUTH_BASE_URL,
    }),
  ).toMatchObject({ status: 403, upgraded: false })
})

it("refuses a chat socket of a banned user", async () => {
  await setBanned(true)
  try {
    expect(
      await upgrade({ cookie: seed?.cookie ?? "", origin: env.AUTH_BASE_URL }),
    ).toMatchObject({ status: 401, upgraded: false })
  } finally {
    await setBanned(false)
  }
})

/** The message of the run error that one turn on the open socket gives. */
async function turnError(data: ConversationWebSocketData): Promise<string> {
  return new Promise((resolve) => {
    const ws = {
      data,
      readyState: 1,
      send(raw: string) {
        const frame = JSON.parse(raw) as {
          type?: string
          message?: string
          chunk?: { type: string; message?: string }
        }
        const chunk = frame.chunk ?? frame
        if (chunk.type !== "RUN_ERROR") return
        resolve(chunk.message ?? "")
        queueMicrotask(() => conversationWebSocketHandlers.close(ws))
      },
      close() {},
    }
    conversationWebSocketHandlers.open(ws)
    conversationWebSocketHandlers.message(
      ws,
      JSON.stringify({
        threadId: data.conversationId,
        runId: `run-${crypto.randomUUID()}`,
        messages: [{ id: "user-1", role: "user", content: "Hello" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { source: "ui" },
      }),
    )
  })
}

it("refuses each turn of an open socket after a ban, a removal or the end of the session", async () => {
  if (!seed) throw new Error("seedOrg did not run")
  const { data } = await upgrade({
    cookie: seed.cookie,
    origin: env.AUTH_BASE_URL,
  })
  if (!data) throw new Error("the socket did not open")
  // A turn with no Workspace ends at once: the user may act.
  expect(await turnError(data)).toBe("workspace_required")

  await setBanned(true)
  expect(await turnError(data)).toBe("unauthorized")
  await setBanned(false)

  const db = getSystemDb()
  const [member] = await db
    .select()
    .from(members)
    .where(eq(members.userId, seed.userId))
  if (!member) throw new Error("the seeded user is not a member")
  await db.delete(members).where(eq(members.id, member.id))
  expect(await turnError(data)).toBe("unauthorized")
  await db.insert(members).values(member)
  expect(await turnError(data)).toBe("workspace_required")

  await db.delete(sessions).where(eq(sessions.id, data.sessionId))
  expect(await turnError(data)).toBe("unauthorized")
})
