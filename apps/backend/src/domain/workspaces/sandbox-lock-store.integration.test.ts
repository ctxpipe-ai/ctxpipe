import { setTimeout as delay } from "node:timers/promises"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { closeDb, getSystemDb, initDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { generateObjectId } from "../../lib/id.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"

const orgId = generateObjectId("org")

beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for the sandbox lock test")
  initDb(process.env.DATABASE_URL)
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Sandbox lock wake-up",
    createdAt: new Date(),
  })
})

afterAll(async () => {
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

it("starts a waiting turn at once when the prepare releases the lock", async () => {
  const key = `chat-thread:${generateObjectId("conv")}`
  let releaseFirst!: () => void
  let prepareEnded = 0
  const holding = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let prepareEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    prepareEntered = resolve
  })
  const prepare = postgresSandboxLocks(orgId).withLock(key, async () => {
    prepareEntered()
    await holding
    prepareEnded = Date.now()
  })
  await entered
  let turnStarted = 0
  const turn = postgresSandboxLocks(orgId).withLock(key, async () => {
    turnStarted = Date.now()
  })
  // The turn's first attempt fails while the prepare holds the lock.
  await delay(50)
  expect(turnStarted).toBe(0)
  releaseFirst()
  await Promise.all([prepare, turn])
  // A 250 ms poll starts the turn about 200 ms after the release.
  expect(turnStarted - prepareEnded).toBeLessThan(120)
})
