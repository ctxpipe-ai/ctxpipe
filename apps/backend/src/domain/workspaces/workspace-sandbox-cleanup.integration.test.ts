import { eq } from "drizzle-orm"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { getSandboxInstance } from "../../models/workspaces.js"
import { sweepConversationSandboxes } from "./conversation-sandbox-lifecycle.js"
import {
  collectUnusedWorkspaceBases,
  destroyWorkspaceSandbox,
} from "./workspace-sandbox-cleanup.js"

/*
 * Rows of the removed Vercel provider can stay in a database after the
 * move to AgentCore. A delete must not be refused because of one, and the
 * sweep must not keep one. No provider is called: the removal of the Vercel
 * projects deletes their sandboxes and snapshots.
 */

beforeAll(() => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the sandbox cleanup")
  initDb(url)
})
afterAll(async () => {
  await closeDb()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** An org with one Workspace, one conversation, and old Vercel rows. */
async function withVercelRows<T>(
  fn: (input: {
    orgId: string
    workspaceId: string
    chatId: string
    baseId: string
  }) => Promise<T>,
): Promise<T> {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  const conversationId = generateObjectId("conv")
  const chatId = generateObjectId("sbx")
  const baseId = `base:${workspaceId}:run_old`
  const revision = {
    workspaceId,
    remote: { url: "https://example.test/context.git", connectionId: null },
    sha: "a".repeat(40),
    generation: 1,
    defaultBranch: "main",
    access: "read" as const,
  }
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Vercel row cleanup",
    createdAt: new Date(),
  })
  try {
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: revision.remote.url,
      })
      await db.insert(conversations).values({
        id: conversationId,
        orgId,
        name: "Old thread",
        workspaceId,
      })
      await db.insert(workspaceSandboxInstances).values([
        {
          id: chatId,
          kind: "chat",
          orgId,
          workspaceId,
          conversationId,
          provider: "vercel",
          providerSandboxId: "sbx-old-chat",
          latestSnapshotId: "snap_old_chat",
          image: "vercel-agent",
          revision,
          state: "stopped",
          lastHeartbeatAt: new Date(),
        },
        {
          id: baseId,
          kind: "base",
          orgId,
          workspaceId,
          conversationId: null,
          provider: "vercel",
          providerSandboxId: "sbx-old-builder",
          latestSnapshotId: "snap_old_base",
          image: "vercel-agent/node26/opencode-ai@1.18.34",
          revision,
          state: "destroy_failed",
          lastHeartbeatAt: new Date(),
        },
      ])
    })
    return await fn({ orgId, workspaceId, chatId, baseId })
  } finally {
    await withOrgDbContext(orgId, async (db) => {
      await db
        .delete(workspaceSandboxInstances)
        .where(eq(workspaceSandboxInstances.orgId, orgId))
      await db.delete(conversations).where(eq(conversations.orgId, orgId))
      await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
}

describe("old Vercel sandbox rows (Postgres)", () => {
  it("deletes a Vercel conversation sandbox row with no provider call", async () => {
    await withVercelRows(async ({ orgId, chatId }) => {
      expect(await destroyWorkspaceSandbox(chatId, orgId)).toBe(true)
      expect(await getSandboxInstance(chatId, orgId)).toBeNull()
    })
  })

  it("deletes a failed Vercel Workspace base row at the hosted sweep, where AgentCore has no bases", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
    vi.stubEnv(
      "AGENTCORE_RUNTIME_ARN",
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/ctxpipe-abc",
    )
    await withVercelRows(async ({ orgId, baseId }) => {
      const now = new Date()
      const { nextSweepAt } = await sweepConversationSandboxes(orgId, now)
      expect(await getSandboxInstance(baseId, orgId)).toBeNull()
      // The base schedules no retry: the next sweep is the conversation
      // sandbox's own delete time, days away.
      expect(
        nextSweepAt?.getTime() ?? Number.POSITIVE_INFINITY,
      ).toBeGreaterThan(now.getTime() + 24 * 60 * 60_000)
    })
  })

  it("deletes a failed Vercel Workspace base row at the base cleanup, so it does not come back", async () => {
    await withVercelRows(async ({ orgId, workspaceId, baseId }) => {
      expect(
        await collectUnusedWorkspaceBases({
          orgId,
          workspaceId,
          agent: { provider: "docker", image: "sha256:current" },
        }),
      ).toBe(1)
      expect(await getSandboxInstance(baseId, orgId)).toBeNull()
    })
  })
})
