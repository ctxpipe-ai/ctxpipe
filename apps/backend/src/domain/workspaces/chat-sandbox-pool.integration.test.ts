import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSecrets,
  defineSandbox,
  defineWorkspace,
  gitSource,
} from "@tanstack/ai-sandbox"
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
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  claimPoolSession,
  listSandboxInstances,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import { RUNTIME_ARN, startFakeAgentCore } from "../../test/agentcore-fake.js"
import type { RunVault } from "./agent-vault.js"
import { agentCoreSandboxProvider } from "./agentcore-sandbox-provider.js"
import {
  fillChatSandboxPool,
  POOL_SESSION_TTL_MS,
  withPoolClaim,
} from "./chat-sandbox-pool.js"
import {
  sweepConversationSandboxes,
  withConversationSandboxSlots,
} from "./conversation-sandbox-lifecycle.js"
import type { WorkspaceRevision } from "./revision.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { workspaceLockUntilCreated } from "./sandbox-lock-store.js"
import { withDestroyedWorkspaceSandboxes } from "./workspace-sandbox-cleanup.js"

/*
 * The warm pool of AgentCore chat sessions (CTX-1323), against Postgres and
 * the AgentCore provider on a fake endpoint. Each Workspace repository is a
 * local bare repository. The fake has one microVM: a new session empties it.
 */
let fake: Awaited<ReturnType<typeof startFakeAgentCore>>
let repo = ""
/** The repository URL of each test Workspace. */
const repoUrls = new Map<string, string>()

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for the pool rows")
  initDb(url)
  fake = await startFakeAgentCore()
  repo = mkdtempSync(join(tmpdir(), "pool-repo-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" })
  git("init", "-q", "-b", "main", "work")
  writeFileSync(join(repo, "work", "README.md"), "pool\n")
  execFileSync("git", ["add", "."], { cwd: join(repo, "work") })
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "first",
    ],
    { cwd: join(repo, "work") },
  )
  for (let index = 0; index < 4; index++)
    git("clone", "-q", "--bare", "work", `context-${index}.git`)
})
afterAll(async () => {
  fake.close()
  rmSync(repo, { recursive: true, force: true })
  await closeDb()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

type Ids = { orgId: string; workspaceIds: string[] }

async function withOrg<T>(
  workspaceCount: number,
  fn: (ids: Ids) => Promise<T>,
): Promise<T> {
  // The cleanup and the sweep stop sessions through the deployment's
  // AgentCore settings.
  vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
  vi.stubEnv("AGENTCORE_RUNTIME_ARN", RUNTIME_ARN)
  vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_AGENTCORE", fake.endpoint)
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test")
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test")
  const orgId = generateObjectId("org")
  const workspaceIds = Array.from({ length: workspaceCount }, (_, index) => {
    const id = generateObjectId("ws")
    repoUrls.set(id, `file://${join(repo, `context-${index}.git`)}`)
    return id
  })
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Pool proof",
    createdAt: new Date(),
  })
  try {
    await withOrgDbContext(orgId, (db) =>
      db.insert(workspaces).values(
        workspaceIds.map((id, index) => ({
          id,
          orgId,
          slug: `context-${index}`,
          displayName: `Context ${index}`,
          workspaceRepositoryUrl: repoUrls.get(id) ?? "",
          desiredGeneration: 1,
          desiredSha: "a".repeat(40),
          desiredDefaultBranch: "main",
        })),
      ),
    )
    return await fn({ orgId, workspaceIds })
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

const revisionOf = (workspaceId: string): WorkspaceRevision => ({
  workspaceId,
  remote: { url: repoUrls.get(workspaceId) ?? "", connectionId: null },
  sha: "a".repeat(40),
  generation: 1,
  defaultBranch: "main",
  access: "read",
})

const provider = () =>
  agentCoreSandboxProvider({ runtime: fake.runtime, paths: fake.paths })

/** A vault double that records its close and the pool row's state then. */
function fakeVault(orgId: string) {
  const events: { closed: boolean; rowStates: string[] } = {
    closed: false,
    rowStates: [],
  }
  const open = async (): Promise<RunVault> => ({
    name: "pool-vault",
    caPem: "",
    addRules: async () => {},
    env: { HTTPS_PROXY: "http://pool:POOL-SECRET@127.0.0.1:9" },
    close: async () => {
      events.closed = true
      events.rowStates = (
        await withOrgDbContext(orgId, () =>
          listSandboxInstances({ kind: "pool" }),
        )
      ).map((row) => row.state)
    },
  })
  return { events, open }
}

function fill(
  orgId: string,
  workspaceId: string,
  openVault: () => Promise<RunVault> = fakeVault(orgId).open,
) {
  return fillChatSandboxPool({
    orgId,
    workspaceId,
    revision: revisionOf(workspaceId),
    provider,
    openVault,
  })
}

const poolRows = (orgId: string) =>
  withOrgDbContext(orgId, () => listSandboxInstances({ kind: "pool" }))

/** Start the chat sandbox of a new conversation through the pool claim. */
async function startChatSandbox(
  ids: { orgId: string; workspaceId: string },
  secrets: Record<string, string> = {},
) {
  const { orgId, workspaceId } = ids
  const conversationId = generateObjectId("conv")
  await withOrgDbContext(orgId, (db) =>
    db.insert(conversations).values({ id: conversationId, orgId, workspaceId }),
  )
  const revision = revisionOf(workspaceId)
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
        withPoolClaim(provider(), { orgId, workspaceId, revision }),
        owner,
      ),
    ),
    workspace: defineWorkspace({
      source: gitSource({
        url: revision.remote.url,
        ref: "main",
        auth: { token: "" },
      }),
      secrets: createSecrets(secrets),
      setup: ["test -f README.md"],
    }),
  })
  return sandbox.ensure({
    threadId: conversationId,
    runId: "run_1",
    store: postgresSandboxInstanceStore(owner),
    locks: workspaceLock.locks(),
    tenant: { orgId },
  })
}

/** Every file under `dir` whose content holds `text`. */
function filesHolding(dir: string, text: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter(
      (path) =>
        statSync(path).isFile() && readFileSync(path, "utf8").includes(text),
    )
}

describe("the warm pool of AgentCore chat sessions (Postgres)", () => {
  it("a new conversation claims the ready session with its clone, and the next one gets another session", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      expect(await fill(orgId, workspaceId)).toBe("filled")
      const [ready] = await poolRows(orgId)
      expect(ready?.state).toBe("live")
      const pooled = ready?.providerSandboxId ?? ""
      // A file that only the fill's clone has: a new clone would not keep it.
      writeFileSync(join(fake.paths.workdir, "made-by-fill"), "")

      const first = await startChatSandbox({ orgId, workspaceId })
      expect(first.id).toBe(pooled)
      expect(existsSync(join(fake.paths.workdir, "made-by-fill"))).toBe(true)
      expect(await poolRows(orgId)).toEqual([])
      const chat = await withOrgDbContext(orgId, () =>
        listSandboxInstances({ kind: "chat" }),
      )
      expect(chat.map((row) => row.providerSandboxId)).toEqual([pooled])

      const second = await startChatSandbox({ orgId, workspaceId })
      expect(second.id).not.toBe(pooled)
      expect(existsSync(join(fake.paths.workdir, "README.md"))).toBe(true)
    })
  }, 60_000)

  it("parallel claims never take one session twice", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      const revision = revisionOf(workspaceId)
      for (let round = 0; round < 5; round++) {
        const sessions = ["a", "b", "c"].map(
          (name) => `ctxpipe-${round}-${name}-${"0".repeat(24)}`,
        )
        for (const sessionId of sessions)
          await persistSandboxInstance({
            id: `pool-${sessionId}`,
            kind: "pool",
            orgId,
            workspaceId,
            provider: "agentcore",
            providerSandboxId: sessionId,
            image: "agentcore-agent",
            revision,
            state: "live",
            lastHeartbeatAt: new Date(),
          })
        const claims = await Promise.all(
          Array.from({ length: 10 }, () =>
            claimPoolSession({
              orgId,
              workspaceId,
              revision,
              readySince: new Date(Date.now() - 60_000),
            }),
          ),
        )
        const taken = claims.filter((id): id is string => id !== null)
        expect(taken.sort()).toEqual([...sessions].sort())
        expect(await poolRows(orgId)).toEqual([])
      }
    })
  }, 60_000)

  it("a claim takes only a session of the same repository generation, connection, and wait", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      const revision = revisionOf(workspaceId)
      const row = (id: string, change: Partial<WorkspaceRevision>, at: Date) =>
        persistSandboxInstance({
          id: `pool-${id}`,
          kind: "pool",
          orgId,
          workspaceId,
          provider: "agentcore",
          providerSandboxId: id,
          image: "agentcore-agent",
          revision: { ...revision, ...change },
          state: "live",
          lastHeartbeatAt: at,
        })
      const now = new Date()
      await row("old-generation", { generation: 2 }, now)
      await row(
        "other-connection",
        { remote: { url: revision.remote.url, connectionId: "con_other" } },
        now,
      )
      await row(
        "other-repository",
        { remote: { url: `${revision.remote.url}x`, connectionId: null } },
        now,
      )
      await row("other-branch", { defaultBranch: "develop" }, now)
      await row("waited-too-long", {}, new Date(now.getTime() - 60 * 60_000))
      expect(
        await claimPoolSession({
          orgId,
          workspaceId,
          revision,
          readySince: new Date(now.getTime() - 60_000),
        }),
      ).toBeNull()
      expect(await poolRows(orgId)).toHaveLength(5)
    })
  }, 60_000)

  it("an unclaimed session holds no credential, and its vault closes before it waits", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      const vault = fakeVault(orgId)
      expect(await fill(orgId, workspaceId, vault.open)).toBe("filled")
      // The only way out of a session is its vault: closed while the row
      // was still filling, so no claim saw the session with a proxy session.
      expect(vault.events).toEqual({ closed: true, rowStates: ["building"] })
      expect(filesHolding(fake.paths.state, "POOL-SECRET")).toEqual([])
      expect(filesHolding(fake.paths.workdir, "POOL-SECRET")).toEqual([])
      expect(existsSync(join(fake.paths.state, "env.sh"))).toBe(false)

      // The claimer's commands get its own credentials, not the fill's.
      const claimed = await startChatSandbox(
        { orgId, workspaceId },
        { HTTPS_PROXY: "http://conv:CONV-SECRET@127.0.0.1:9" },
      )
      const env = (await claimed.process.exec("env")).stdout
      expect(env).toContain("CONV-SECRET")
      expect(env).not.toContain("POOL-SECRET")
    })
  }, 60_000)

  it("keeps at most one session for each Workspace and three for each organization", async () => {
    await withOrg(4, async ({ orgId, workspaceIds }) => {
      const [first = "", second = "", third = "", fourth = ""] = workspaceIds
      expect(await fill(orgId, first)).toBe("filled")
      expect(await fill(orgId, first)).toBe("full")
      expect(await fill(orgId, second)).toBe("filled")
      expect(await fill(orgId, third)).toBe("filled")
      expect(await fill(orgId, fourth)).toBe("full")
      expect(await poolRows(orgId)).toHaveLength(3)
    })
  }, 60_000)

  it("a Workspace delete during a fill waits for it, then stops the session", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      let release = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      const vault = fakeVault(orgId)
      const runningBefore = new Set(fake.running)
      const filling = fill(orgId, workspaceId, async () => {
        await gate
        return vault.open()
      })
      await vi.waitFor(async () =>
        expect(await poolRows(orgId)).toHaveLength(1),
      )
      let done = false
      const deleting = withDestroyedWorkspaceSandboxes(
        { orgId, workspaceId },
        async () => {},
      ).finally(() => {
        done = true
      })
      // The delete holds the Workspace lock and waits for the fill's own lock.
      await vi.waitFor(async () =>
        expect(
          await withOrgDbContext(orgId, (db) =>
            db
              .select({ key: sandboxLocks.key })
              .from(sandboxLocks)
              .where(
                eq(sandboxLocks.key, `workspace-sandboxes:${workspaceId}`),
              ),
          ),
        ).toHaveLength(1),
      )
      expect(done).toBe(false)
      release()
      expect(await filling).toBe("filled")
      await deleting
      expect(await poolRows(orgId)).toEqual([])
      expect([...fake.running].filter((id) => !runningBefore.has(id))).toEqual(
        [],
      )
    })
  }, 60_000)

  it("fills nothing for a binding that a relink replaced before the fill", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      // The relink came first: its cleanup listed no pool row.
      await withOrgDbContext(orgId, (db) =>
        db
          .update(workspaces)
          .set({ desiredGeneration: 2 })
          .where(eq(workspaces.id, workspaceId)),
      )
      const runningBefore = new Set(fake.running)
      expect(await fill(orgId, workspaceId)).toBe("stale")
      expect(await poolRows(orgId)).toEqual([])
      expect([...fake.running].filter((id) => !runningBefore.has(id))).toEqual(
        [],
      )
    })
  }, 60_000)

  it("counts a session after its wait until the sweep stops it", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      expect(await fill(orgId, workspaceId)).toBe("filled")
      const [ready] = await poolRows(orgId)
      if (!ready) throw new Error("No pool row")
      // Its wait is over, and the sweep has not stopped it yet.
      await persistSandboxInstance({
        ...ready,
        lastHeartbeatAt: new Date(Date.now() - 2 * POOL_SESSION_TTL_MS),
      })
      expect(await fill(orgId, workspaceId)).toBe("full")
      await sweepConversationSandboxes(orgId)
      expect(await fill(orgId, workspaceId)).toBe("filled")
    })
  }, 60_000)

  it("a claim whose marker check fails stops that session and starts cold", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      expect(await fill(orgId, workspaceId)).toBe("filled")
      const [ready] = await poolRows(orgId)
      const pooled = ready?.providerSandboxId ?? ""
      fake.failNextCommand("platform")
      const handle = await startChatSandbox({ orgId, workspaceId })
      expect(handle.id).not.toBe(pooled)
      expect(fake.running.has(pooled)).toBe(false)
    })
  }, 60_000)

  it("the sweep stops a ready session at the end of its wait", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      expect(await fill(orgId, workspaceId)).toBe("filled")
      const [ready] = await poolRows(orgId)
      const readyAt = ready?.lastHeartbeatAt.getTime() ?? 0
      const early = await sweepConversationSandboxes(
        orgId,
        new Date(readyAt + 5 * 60_000),
      )
      expect(early.nextSweepAt?.getTime()).toBe(readyAt + POOL_SESSION_TTL_MS)
      expect(await poolRows(orgId)).toHaveLength(1)
      const late = await sweepConversationSandboxes(
        orgId,
        new Date(readyAt + POOL_SESSION_TTL_MS),
      )
      expect(late.deleted).toBe(1)
      expect(await poolRows(orgId)).toEqual([])
      expect(fake.running.has(ready?.providerSandboxId ?? "")).toBe(false)
    })
  }, 60_000)

  it("a pool session that AgentCore stopped gives a cold start", async () => {
    await withOrg(1, async ({ orgId, workspaceIds: [workspaceId = ""] }) => {
      expect(await fill(orgId, workspaceId)).toBe("filled")
      const [ready] = await poolRows(orgId)
      const pooled = ready?.providerSandboxId ?? ""
      // AgentCore ends an idle session; a later call starts an empty microVM.
      fake.running.delete(pooled)
      const handle = await startChatSandbox({ orgId, workspaceId })
      expect(handle.id).not.toBe(pooled)
      expect(existsSync(join(fake.paths.workdir, "README.md"))).toBe(true)
    })
  }, 60_000)
})
