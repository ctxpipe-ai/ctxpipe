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
import { RUNTIME_ARN, startFakeAgentCore } from "../../test/agentcore-fake.js"
import { CHAT_SANDBOX_IDLE_STOP_MS } from "./chat-lifecycle.js"
import { sweepConversationSandboxes } from "./conversation-sandbox-lifecycle.js"

let fake: Awaited<ReturnType<typeof startFakeAgentCore>>

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the sandbox sweep")
  initDb(url)
  fake = await startFakeAgentCore()
})
afterAll(async () => {
  fake.close()
  await closeDb()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** The deployment's AgentCore settings, pointed at the fake endpoint. */
function useAgentCore() {
  vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
  vi.stubEnv("AGENTCORE_RUNTIME_ARN", RUNTIME_ARN)
  vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_AGENTCORE", fake.endpoint)
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test")
}

/** An org with a conversation whose AgentCore sandbox was last used `idleMs` ago. */
async function withAgentCoreSandbox<T>(
  idleMs: number,
  fn: (input: {
    orgId: string
    rowId: string
    sessionId: string
  }) => Promise<T>,
): Promise<T> {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  const conversationId = generateObjectId("conv")
  const rowId = generateObjectId("sbx")
  const sessionId = `ctxpipe-${"ab".repeat(16)}${Date.now()}`
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "AgentCore sweep proof",
    createdAt: new Date(),
  })
  try {
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: "https://example.test/context.git",
      })
      await db.insert(conversations).values({
        id: conversationId,
        orgId,
        name: "AgentCore thread",
        workspaceId,
      })
      await db.insert(workspaceSandboxInstances).values({
        id: rowId,
        kind: "chat",
        orgId,
        workspaceId,
        conversationId,
        provider: "agentcore",
        providerSandboxId: sessionId,
        image: "agentcore-agent",
        revision: {
          workspaceId,
          remote: {
            url: "https://example.test/context.git",
            connectionId: null,
          },
          sha: "a".repeat(40),
          generation: 1,
          defaultBranch: "main",
          access: "read",
        },
        state: "live",
        lastHeartbeatAt: new Date(Date.now() - idleMs),
      })
    })
    // The session runs at AgentCore.
    fake.running.add(sessionId)
    return await fn({ orgId, rowId, sessionId })
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

describe("the sweep of AgentCore conversation sandboxes (Postgres)", () => {
  it("deletes an idle sandbox instead of a stop, because a stopped session keeps no files", async () => {
    useAgentCore()
    await withAgentCoreSandbox(
      CHAT_SANDBOX_IDLE_STOP_MS + 60_000,
      async ({ orgId, rowId, sessionId }) => {
        const result = await sweepConversationSandboxes(orgId)
        expect(result).toMatchObject({ stopped: 0, deleted: 1 })
        expect(await getSandboxInstance(rowId, orgId)).toBeNull()
        expect(fake.running.has(sessionId)).toBe(false)
        expect(
          fake.calls.some(
            (call) =>
              call.api === "stopruntimesession" && call.sessionId === sessionId,
          ),
        ).toBe(true)
      },
    )
  })

  it("keeps a sandbox that was used in the last 5 minutes, with no AgentCore call", async () => {
    useAgentCore()
    await withAgentCoreSandbox(60_000, async ({ orgId, rowId, sessionId }) => {
      const result = await sweepConversationSandboxes(orgId)
      expect(result).toMatchObject({ stopped: 0, deleted: 0 })
      expect((await getSandboxInstance(rowId, orgId))?.state).toBe("live")
      expect(fake.calls.some((call) => call.sessionId === sessionId)).toBe(
        false,
      )
    })
  })
})
