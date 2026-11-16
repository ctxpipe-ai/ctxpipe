import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineSandbox, defineWorkspace } from "@tanstack/ai-sandbox"
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
import { listSandboxInstances } from "../../models/workspaces.js"
import { RUNTIME_ARN, startFakeAgentCore } from "../../test/agentcore-fake.js"
import { agentCoreSandboxProvider } from "./agentcore-sandbox-provider.js"
import { withConversationSandboxSlots } from "./conversation-sandbox-lifecycle.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { workspaceLockUntilCreated } from "./sandbox-lock-store.js"
import { withDestroyedWorkspaceSandboxes } from "./workspace-sandbox-cleanup.js"

/*
 * Chat sandbox starts in one Workspace, against Postgres and the AgentCore
 * provider on a fake endpoint. A start holds the Workspace lock only until
 * its sandbox is created, as `buildWorkspaceChatSandbox` composes it: the
 * slots reserve the row, the provider creates, then the setup runs.
 */
let fake: Awaited<ReturnType<typeof startFakeAgentCore>>
let dir = ""

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the sandbox locks")
  initDb(url)
  fake = await startFakeAgentCore()
})
afterAll(async () => {
  fake.close()
  await closeDb()
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

async function withWorkspace<T>(
  fn: (ids: { orgId: string; workspaceId: string }) => Promise<T>,
): Promise<T> {
  // The cleanup stops sessions through the deployment's AgentCore settings.
  vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
  vi.stubEnv("AGENTCORE_RUNTIME_ARN", RUNTIME_ARN)
  vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_AGENTCORE", fake.endpoint)
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test")
  dir = mkdtempSync(join(tmpdir(), "workspace-lock-"))
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Workspace lock proof",
    createdAt: new Date(),
  })
  try {
    await withOrgDbContext(orgId, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: "https://example.test/context.git",
      }),
    )
    return await fn({ orgId, workspaceId })
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

/** Start the chat sandbox of a new conversation, with these setup steps. */
async function startChatSandbox(
  ids: { orgId: string; workspaceId: string },
  setup: string[],
) {
  const { orgId, workspaceId } = ids
  const conversationId = generateObjectId("conv")
  await withOrgDbContext(orgId, (db) =>
    db.insert(conversations).values({ id: conversationId, orgId, workspaceId }),
  )
  const revision = {
    workspaceId,
    remote: { url: "https://example.test/context.git", connectionId: null },
    sha: "a".repeat(40),
    generation: 1,
    defaultBranch: "main",
    access: "read" as const,
  }
  const owner = {
    orgId,
    workspaceId,
    conversationId,
    provider: "agentcore" as const,
    image: "agentcore-agent",
    revision,
  }
  const workspaceLock = workspaceLockUntilCreated(orgId, workspaceId)
  const sandbox = defineSandbox({
    id: "chat",
    provider: workspaceLock.provider(
      withConversationSandboxSlots(
        agentCoreSandboxProvider({ runtime: fake.runtime, paths: fake.paths }),
        owner,
      ),
    ),
    workspace: defineWorkspace({ source: { type: "none" }, setup }),
  })
  return sandbox.ensure({
    threadId: conversationId,
    runId: "run_1",
    store: postgresSandboxInstanceStore(owner),
    locks: workspaceLock.locks(),
    tenant: { orgId },
  })
}

/** A setup step that says it started, then waits for `go`. */
const blockedSetup = () => [
  `touch ${join(dir, "started")}; while [ ! -f ${join(dir, "go")} ]; do sleep 0.05; done`,
]

describe("the Workspace lock of a chat sandbox start (Postgres)", () => {
  it("lets the next conversation of the Workspace start while the first one's setup runs", async () => {
    await withWorkspace(async (ids) => {
      const first = startChatSandbox(ids, blockedSetup())
      await vi.waitFor(
        () => expect(existsSync(join(dir, "started"))).toBe(true),
        {
          timeout: 20_000,
        },
      )
      const second = await Promise.race([
        startChatSandbox(ids, ["true"]).then(() => "started"),
        new Promise((resolve) => setTimeout(resolve, 15_000, "waited")),
      ])
      writeFileSync(join(dir, "go"), "")
      await first
      expect(second).toBe("started")
    })
  }, 60_000)

  it("a Workspace delete during the first setup destroys that sandbox after its setup", async () => {
    await withWorkspace(async (ids) => {
      const first = startChatSandbox(ids, blockedSetup())
      await vi.waitFor(
        () => expect(existsSync(join(dir, "started"))).toBe(true),
        {
          timeout: 20_000,
        },
      )
      let deleted = false
      const deleting = withDestroyedWorkspaceSandboxes(
        ids,
        async (remaining) => {
          deleted = true
          return remaining
        },
      )
      // The delete waits for the sandbox's own lock, which the setup holds.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(deleted).toBe(false)
      writeFileSync(join(dir, "go"), "")
      const handle = await first
      expect(await deleting).toEqual([])
      expect(
        await withOrgDbContext(ids.orgId, () =>
          listSandboxInstances({ workspaceId: ids.workspaceId }),
        ),
      ).toEqual([])
      expect(fake.running.has(handle.id)).toBe(false)
    })
  }, 60_000)
})
