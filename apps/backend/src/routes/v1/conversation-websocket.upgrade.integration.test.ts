import { afterAll, beforeAll, expect, it } from "vitest"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { handleConversationWebSocket } from "./conversation-websocket.js"

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
  const upgrades: unknown[] = []
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
  return { status: response?.status, upgraded: upgrades.length === 1 }
}

it("upgrades a signed-in chat socket from AUTH_BASE_URL or an allowed origin", async () => {
  for (const origin of [env.AUTH_BASE_URL, "https://ui.example.test"]) {
    expect(await upgrade({ cookie: seed?.cookie ?? "", origin })).toEqual({
      status: undefined,
      upgraded: true,
    })
  }
})

it("refuses a chat socket from another origin or with no origin", async () => {
  for (const headers of <Record<string, string>[]>[
    { cookie: seed?.cookie ?? "", origin: "https://other.example.test" },
    { cookie: seed?.cookie ?? "", origin: "null" },
    { cookie: seed?.cookie ?? "" },
  ]) {
    expect(await upgrade(headers)).toEqual({ status: 403, upgraded: false })
  }
})

it("refuses a chat socket that a personal API key opens", async () => {
  expect(
    await upgrade({
      "x-api-key": seed?.personalApiKey ?? "",
      origin: env.AUTH_BASE_URL,
    }),
  ).toEqual({ status: 403, upgraded: false })
})
