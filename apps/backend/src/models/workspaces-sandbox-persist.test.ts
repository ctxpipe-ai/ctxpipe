import { resolve } from "node:path"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { conversations } from "../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../db/schema/workspaces.js"
import { postgresSandboxInstanceStore } from "../domain/workspaces/sandbox-instance-store.js"
import { persistSandboxInstance } from "./workspaces.js"

config({ path: resolve(import.meta.dirname, "../../.env.local"), quiet: true })

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required; run pnpm --filter @ctxpipe/backend test against a migrated Postgres (ctxpipe_app after owner migrate)",
  )
}

const runId = `persist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `${runId}_org`,
  slug: `${runId}-org`,
  name: "Persist sandbox org",
}
const workspaceId = `ws_${runId}`
const conversationId = `conv_${runId}`
const leftoverId = "0b5963a7210b05c7"

beforeAll(async () => {
  initDb(databaseUrl)
  const now = new Date()
  await getSystemDb()
    .insert(organizations)
    .values({ id: org.id, name: org.name, slug: org.slug, createdAt: now })
  await withOrgDbContext(org.id, async (db) => {
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId: org.id,
      slug: `ws-${runId}`,
      displayName: "Persist workspace",
      workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${runId}`,
    })
    await db.insert(conversations).values({
      id: conversationId,
      orgId: org.id,
      name: "Persist conversation",
      workspaceId,
    })
  })
})

afterAll(async () => {
  try {
    await withOrgDbContext(org.id, async (db) => {
      await db
        .delete(workspaceSandboxInstances)
        .where(eq(workspaceSandboxInstances.workspaceId, workspaceId))
      await db.delete(conversations).where(eq(conversations.id, conversationId))
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
  } finally {
    await closeDb()
  }
})

async function liveChatRows() {
  return withOrgDbContext(org.id, async (db) =>
    db
      .select({
        id: workspaceSandboxInstances.id,
        providerSandboxId: workspaceSandboxInstances.providerSandboxId,
        state: workspaceSandboxInstances.state,
      })
      .from(workspaceSandboxInstances)
      .where(eq(workspaceSandboxInstances.conversationId, conversationId)),
  )
}

describe("persistSandboxInstance live chat identity", () => {
  it("keeps the live chat row id when the next turn upserts a new instance key", async () => {
    await persistSandboxInstance({
      id: leftoverId,
      kind: "chat",
      orgId: org.id,
      workspaceId,
      conversationId,
      provider: "docker",
      providerSandboxId: "ctr_old",
      state: "live",
      lastHeartbeatAt: new Date("2026-08-23T00:00:00.000Z"),
    })

    const store = postgresSandboxInstanceStore({
      orgId: org.id,
      workspaceId,
    })
    await expect(
      store.upsert({
        key: "a1b2c3d4e5f60708",
        provider: "docker",
        providerSandboxId: "ctr_new",
        threadId: conversationId,
        updatedAt: Date.parse("2026-08-23T00:01:00.000Z"),
      }),
    ).resolves.toBeUndefined()

    const afterResume = await liveChatRows()
    expect(afterResume).toEqual([
      {
        id: leftoverId,
        providerSandboxId: "ctr_new",
        state: "live",
      },
    ])
  })
})
