import type { StreamChunk } from "@tanstack/ai"
import { defineSandbox } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import Docker from "dockerode"
import { eq } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
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
import { scheduleConversationSandboxSweep } from "../../openworkflow/workflows/conversation-sandbox-sweep.js"
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import {
  CHAT_SANDBOX_DELETE_AFTER_MS,
  CHAT_SANDBOX_IDLE_STOP_MS,
  ORG_RUNNING_SANDBOX_LIMIT,
} from "./chat-lifecycle.js"
import {
  SandboxCapacityError,
  stopConversationSandboxes,
  stoppingSandboxWhenDone,
  sweepConversationSandboxes,
  withConversationSandboxSlots,
} from "./conversation-sandbox-lifecycle.js"
import type { WorkspaceRevision } from "./revision.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import {
  streamTanstackWorkspaceChat,
  type TanstackWorkspaceChatInput,
} from "./tanstack-workspace-chat.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"
import { destroySandboxesForWorkspace } from "./workspace-sandbox-cleanup.js"

const IMAGE = "alpine:3.22"
const FIVE_MINUTES = 5 * 60_000
const docker = new Docker({ timeout: 30_000 })

afterAll(async () => {
  const { closeOpenWorkflowClient } = await import(
    "../../openworkflow/client.js"
  )
  await closeOpenWorkflowClient()
  await closeDb()
})

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for sandbox lifecycle")
  return url
}

/** The next 5-minute boundary after `at`: where busy and failed sweeps retry. */
function nextRetryBoundary(at: number): Date {
  return new Date(Math.floor(at / FIVE_MINUTES) * FIVE_MINUTES + FIVE_MINUTES)
}

/** Chat inspects its image before any sandbox exists. */
async function pullImage(): Promise<void> {
  const exists = await docker
    .getImage(IMAGE)
    .inspect()
    .then(
      () => true,
      () => false,
    )
  if (exists) return
  const stream = await docker.pull(IMAGE)
  await new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(stream, (error) =>
      error ? reject(error) : resolve(),
    ),
  )
}

async function running(containerId: string): Promise<boolean | "gone"> {
  try {
    return (await docker.getContainer(containerId).inspect()).State.Running
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return "gone"
    throw error
  }
}

/** Sweep runs queued for one org, by when they are due. */
async function queuedSweeps(orgId: string): Promise<number[]> {
  const backend = await BackendPostgres.connect(databaseUrl(), {
    runMigrations: false,
  })
  try {
    return (await backend.listWorkflowRuns({ limit: 1000 })).data
      .filter(
        (run) =>
          run.workflowName === "conversation-sandbox-sweep" &&
          (run.input as { orgId?: string })?.orgId === orgId,
      )
      .map((run) => run.availableAt?.getTime() ?? 0)
      .sort((a, b) => a - b)
  } finally {
    await backend.stop()
  }
}

/** Real Postgres rows for an org, a Workspace and its conversations. */
async function withOrg<T>(
  fn: (org: {
    orgId: string
    workspaceId: string
    conversation: () => Promise<string>
  }) => Promise<T>,
): Promise<T> {
  initDb(databaseUrl())
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Sandbox lifecycle proof",
    createdAt: new Date(),
  })
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: "https://example.test/context.git",
    }),
  )
  try {
    return await fn({
      orgId,
      workspaceId,
      conversation: async () => {
        const id = generateObjectId("conv")
        await withOrgDbContext(orgId, (db) =>
          db.insert(conversations).values({ id, orgId, workspaceId }),
        )
        return id
      },
    })
  } finally {
    await withOrgIdContext({ id: orgId, slug: orgId }, () =>
      destroySandboxesForWorkspace(workspaceId),
    )
    await withOrgDbContext(orgId, async (db) => {
      await db.delete(conversations).where(eq(conversations.orgId, orgId))
      await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
}

/**
 * A conversation sandbox as chat builds it: stock `defineSandbox` and Docker
 * provider over our Postgres store and locks, behind the org's slots.
 */
function conversationSandbox(input: {
  orgId: string
  workspaceId: string
  conversationId: string
  image?: string
}) {
  const image = input.image ?? IMAGE
  const revision: WorkspaceRevision = {
    workspaceId: input.workspaceId,
    remote: { url: "https://example.test/context.git", connectionId: null },
    sha: "a".repeat(40),
    generation: 1,
    defaultBranch: "main",
    access: "read",
  }
  const owner = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    provider: "docker" as const,
    image,
    revision,
  }
  const provider = withConversationSandboxSlots(
    dockerSandbox({ image, workdir: "/tmp" }),
    owner,
  )
  const definition = defineSandbox({
    id: "sandbox-lifecycle-proof",
    provider,
    lifecycle: { reuse: "thread", snapshot: "none", destroyOnComplete: false },
  })
  const ctx = {
    threadId: input.conversationId,
    runId: `run-${input.conversationId}`,
    store: postgresSandboxInstanceStore(owner),
    locks: postgresSandboxLocks(
      input.orgId,
      undefined,
      `workspace-sandboxes:${input.workspaceId}`,
    ),
    tenant: { userId: undefined, orgId: input.orgId },
  }
  return {
    provider,
    key: definition.key(ctx),
    ensure: () => definition.ensure(ctx),
    row: () => getSandboxInstance(definition.key(ctx), input.orgId),
  }
}

/**
 * Fill the org's slots with other running sandboxes. The first is a job
 * sandbox: every running provider sandbox counts, not only conversations.
 */
async function fillSlots(orgId: string, workspaceId: string, count: number) {
  const ids = Array.from(
    { length: count },
    (_, index) => `full-${orgId}-${index}`,
  )
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaceSandboxInstances).values(
      ids.map((id, index) => ({
        id,
        kind: index === 0 ? "job" : "chat",
        orgId,
        workspaceId,
        conversationId: index === 0 ? null : `conv_elsewhere_${id}`,
        provider: "docker",
        providerSandboxId: `container-${id}`,
        state: "live",
        lastHeartbeatAt: new Date(),
      })),
    ),
  )
  return {
    setState: (index: number, state: "live" | "stopped") =>
      withOrgDbContext(orgId, (db) =>
        db
          .update(workspaceSandboxInstances)
          .set({ state })
          .where(eq(workspaceSandboxInstances.id, ids[index] ?? "")),
      ),
    remove: () =>
      withOrgDbContext(orgId, async (db) => {
        for (const id of ids)
          await db
            .delete(workspaceSandboxInstances)
            .where(eq(workspaceSandboxInstances.id, id))
      }),
  }
}

it(
  "stops an idle Docker sandbox after 5 minutes, never mid-turn, and the next start resumes it with its files",
  { timeout: 120_000 },
  async () => {
    await withOrg(async (org) => {
      const conversationId = await org.conversation()
      const sandbox = conversationSandbox({ ...org, conversationId })
      const handle = await sandbox.ensure()
      await handle.process.exec("printf kept > /tmp/kept.txt")
      const started = await sandbox.row()
      if (!started) throw new Error("sandbox row missing")
      expect(started.state).toBe("live")
      const lastUse = started.lastHeartbeatAt.getTime()

      expect(
        await sweepConversationSandboxes(
          org.orgId,
          new Date(lastUse + CHAT_SANDBOX_IDLE_STOP_MS - 1_000),
        ),
      ).toEqual({
        stopped: 0,
        deleted: 0,
        nextSweepAt: new Date(lastUse + CHAT_SANDBOX_IDLE_STOP_MS),
      })

      const idleAt = new Date(lastUse + CHAT_SANDBOX_IDLE_STOP_MS)
      await postgresSandboxLocks(org.orgId).withLock(
        `chat-thread:${conversationId}`,
        async () => {
          // A turn holds the conversation: leave its sandbox alone.
          expect(await sweepConversationSandboxes(org.orgId, idleAt)).toEqual({
            stopped: 0,
            deleted: 0,
            nextSweepAt: nextRetryBoundary(idleAt.getTime()),
          })
        },
      )
      expect(await running(handle.id)).toBe(true)

      // A stopped sandbox schedules its deletion, before its saved state expires.
      expect(await sweepConversationSandboxes(org.orgId, idleAt)).toEqual({
        stopped: 1,
        deleted: 0,
        nextSweepAt: new Date(lastUse + CHAT_SANDBOX_DELETE_AFTER_MS),
      })
      expect(await running(handle.id)).toBe(false)
      expect((await sandbox.row())?.state).toBe("stopped")

      const resumed = await sandbox.ensure()
      expect(resumed.id).toBe(handle.id)
      expect(await running(handle.id)).toBe(true)
      expect((await resumed.process.exec("cat /tmp/kept.txt")).stdout).toBe(
        "kept",
      )
      const after = await sandbox.row()
      expect(after?.state).toBe("live")
      expect(after?.lastHeartbeatAt.getTime()).toBeGreaterThan(lastUse)
    })
  },
)

it(
  "keeps one sweep chain per org: concurrent sweeps schedule the same next run",
  { timeout: 120_000 },
  async () => {
    await withOrg(async (org) => {
      const conversationId = await org.conversation()
      const sandbox = conversationSandbox({ ...org, conversationId })
      await sandbox.ensure()
      const lastUse = (await sandbox.row())?.lastHeartbeatAt.getTime() ?? 0

      // Two runs a little apart compute the same due time from the row.
      const [first, second] = await Promise.all([
        sweepConversationSandboxes(org.orgId, new Date(lastUse + 10_000)),
        sweepConversationSandboxes(org.orgId, new Date(lastUse + 70_000)),
      ])
      expect(first.nextSweepAt).toEqual(second.nextSweepAt)

      // While a turn holds the conversation, retries in one window agree too.
      const idle = lastUse + CHAT_SANDBOX_IDLE_STOP_MS
      const windowStart = Math.ceil(idle / FIVE_MINUTES) * FIVE_MINUTES + 1_000
      const busy = await postgresSandboxLocks(org.orgId).withLock(
        `chat-thread:${conversationId}`,
        () =>
          Promise.all([
            sweepConversationSandboxes(org.orgId, new Date(windowStart)),
            sweepConversationSandboxes(
              org.orgId,
              new Date(windowStart + 2 * 60_000),
            ),
          ]),
      )
      expect(busy[0].nextSweepAt).toEqual(busy[1].nextSweepAt)

      for (const swept of [first, second, ...busy])
        if (swept.nextSweepAt)
          await scheduleConversationSandboxSweep(org.orgId, swept.nextSweepAt)
      // Queued on the minute boundary at or after each due time.
      const onMinute = (at?: Date | null) =>
        Math.ceil((at?.getTime() ?? 0) / 60_000) * 60_000
      expect(await queuedSweeps(org.orgId)).toEqual([
        onMinute(first.nextSweepAt),
        onMinute(busy[0].nextSweepAt),
      ])
    })
  },
)

it(
  "deletes a sandbox and its saved state 29 days after last use, or once its conversation is gone",
  { timeout: 120_000 },
  async () => {
    await withOrg(async (org) => {
      const kept = conversationSandbox({
        ...org,
        conversationId: await org.conversation(),
      })
      const keptHandle = await kept.ensure()
      const orphanConversation = await org.conversation()
      const orphan = conversationSandbox({
        ...org,
        conversationId: orphanConversation,
      })
      const orphanHandle = await orphan.ensure()
      await withOrgDbContext(org.orgId, (db) =>
        db
          .delete(conversations)
          .where(eq(conversations.id, orphanConversation)),
      )
      const lastUse = (await kept.row())?.lastHeartbeatAt.getTime() ?? 0
      expect(await sweepConversationSandboxes(org.orgId)).toEqual({
        stopped: 0,
        deleted: 1,
        nextSweepAt: new Date(lastUse + CHAT_SANDBOX_IDLE_STOP_MS),
      })
      expect(await orphan.row()).toBeNull()
      expect(await running(orphanHandle.id)).toBe("gone")

      const idle = await sweepConversationSandboxes(
        org.orgId,
        new Date(lastUse + CHAT_SANDBOX_IDLE_STOP_MS),
      )
      expect(idle.stopped).toBe(1)
      expect(await running(keptHandle.id)).toBe(false)

      expect(
        await sweepConversationSandboxes(
          org.orgId,
          new Date(lastUse + CHAT_SANDBOX_DELETE_AFTER_MS - 1_000),
        ),
      ).toEqual({
        stopped: 0,
        deleted: 0,
        nextSweepAt: new Date(lastUse + CHAT_SANDBOX_DELETE_AFTER_MS),
      })
      expect(
        await sweepConversationSandboxes(
          org.orgId,
          new Date(lastUse + CHAT_SANDBOX_DELETE_AFTER_MS),
        ),
      ).toEqual({ stopped: 0, deleted: 1, nextSweepAt: null })
      expect(await kept.row()).toBeNull()
      expect(await running(keptHandle.id)).toBe("gone")
    })
  },
)

it(
  "a resume that waited while the sweep deleted the sandbox starts a fresh one instead of reviving the row",
  { timeout: 120_000 },
  async () => {
    await withOrg(async (org) => {
      const conversationId = await org.conversation()
      const sandbox = conversationSandbox({ ...org, conversationId })
      const handle = await sandbox.ensure()
      await stopConversationSandboxes({ orgId: org.orgId, conversationId })
      const stopped = await sandbox.row()
      if (stopped?.state !== "stopped") throw new Error("sandbox not stopped")

      let resumed: Promise<unknown> | undefined
      await postgresSandboxLocks(org.orgId).withLock(
        "org-sandbox-slots",
        async () => {
          // The resume lists the stopped row, then waits for the slot lock.
          resumed = sandbox.provider.resume({ id: handle.id })
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          const swept = await sweepConversationSandboxes(
            org.orgId,
            new Date(
              stopped.lastHeartbeatAt.getTime() + CHAT_SANDBOX_DELETE_AFTER_MS,
            ),
          )
          expect(swept.deleted).toBe(1)
        },
      )
      expect(await resumed).toBeNull()
      expect(await sandbox.row()).toBeNull()
      expect(await running(handle.id)).toBe("gone")

      const fresh = await sandbox.ensure()
      expect(fresh.id).not.toBe(handle.id)
      expect((await sandbox.row())?.state).toBe("live")
    })
  },
)

it(
  "refuses a new or resumed sandbox when the org already runs 50 sandboxes of any kind",
  { timeout: 120_000 },
  async () => {
    await withOrg(async (org) => {
      const conversationId = await org.conversation()
      const sandbox = conversationSandbox({ ...org, conversationId })
      const full = await fillSlots(
        org.orgId,
        org.workspaceId,
        ORG_RUNNING_SANDBOX_LIMIT,
      )
      try {
        const refused = await sandbox.ensure().catch((error: unknown) => error)
        expect(refused).toBeInstanceOf(SandboxCapacityError)
        expect((refused as Error).message).toContain("at capacity")
        expect(await sandbox.row()).toBeNull()

        // A stopped sandbox does not hold a slot.
        await full.setState(1, "stopped")
        const handle = await sandbox.ensure()
        expect(await running(handle.id)).toBe(true)

        await stopConversationSandboxes({ orgId: org.orgId, conversationId })
        expect(await running(handle.id)).toBe(false)

        // Resuming takes a slot too.
        await full.setState(1, "live")
        await expect(sandbox.ensure()).rejects.toBeInstanceOf(
          SandboxCapacityError,
        )
        expect(await running(handle.id)).toBe(false)
        expect((await sandbox.row())?.state).toBe("stopped")
      } finally {
        await full.remove()
      }
    })
  },
)

it(
  "gives the slot back at once when a create fails",
  { timeout: 120_000 },
  async () => {
    await withOrg(async (org) => {
      const conversationId = await org.conversation()
      const sandbox = conversationSandbox({
        ...org,
        conversationId,
        image: "ctxpipe-lifecycle-proof.invalid/missing:never",
      })
      const full = await fillSlots(
        org.orgId,
        org.workspaceId,
        ORG_RUNNING_SANDBOX_LIMIT - 1,
      )
      try {
        const failed = await sandbox.ensure().catch((error: unknown) => error)
        expect(failed).toBeInstanceOf(Error)
        expect(failed).not.toBeInstanceOf(SandboxCapacityError)
        expect(await sandbox.row()).toBeNull()
        // Still one slot free: the failed create did not keep it.
        const retried = await sandbox.ensure().catch((error: unknown) => error)
        expect(retried).not.toBeInstanceOf(SandboxCapacityError)
      } finally {
        await full.remove()
      }
    })
  },
)

it(
  "maps the capacity limit to 429 on prepare and a clear error in the chat stream",
  { timeout: 120_000 },
  async () => {
    const previous = process.env.SANDBOX_CHAT_IMAGE
    try {
      await withNativeChatFixture(async (f) => {
        process.env.SANDBOX_PROVIDER = "docker"
        process.env.SANDBOX_CHAT_IMAGE = IMAGE
        await pullImage()
        const full = await fillSlots(
          f.orgId,
          f.workspaceId,
          ORG_RUNNING_SANDBOX_LIMIT,
        )
        try {
          const prepared = await f.request(
            `/conversations/${f.conversationId}/prepare`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceId: f.workspaceId }),
            },
          )
          expect(prepared.status).toBe(429)
          expect(
            ((await prepared.json()) as { error: string }).error,
          ).toContain("at capacity")
          // Opening a conversation counts as use: its idle sweep is queued.
          const [due] = await queuedSweeps(f.orgId)
          expect(due).toBeGreaterThan(Date.now() + 4 * 60_000)
          expect(due).toBeLessThanOrEqual(
            Date.now() + CHAT_SANDBOX_IDLE_STOP_MS + 60_000,
          )

          const sent = await f.request(`/conversations/${f.conversationId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messages: [{ id: "user-full", role: "user", content: "Hello" }],
              tools: [],
              context: [],
              threadId: f.conversationId,
              runId: `${f.conversationId}-full`,
              forwardedProps: { workspaceId: f.workspaceId, source: "ui" },
            }),
          })
          const errors = (await sent.text())
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)) as StreamChunk)
            .filter((chunk) => chunk.type === "RUN_ERROR")
          expect(errors.length).toBeGreaterThanOrEqual(1)
          for (const error of errors)
            expect(error).toMatchObject({
              message: expect.stringContaining("at capacity"),
            })
        } finally {
          await full.remove()
        }
      })
    } finally {
      if (previous === undefined) delete process.env.SANDBOX_CHAT_IMAGE
      else process.env.SANDBOX_CHAT_IMAGE = previous
    }
  },
)

it(
  "a chat not driven from the UI stops its sandbox when it finishes; a UI chat keeps it",
  { timeout: 150_000 },
  async () => {
    await withNativeChatFixture(async (f) => {
      await pullImage()
      const sandbox = conversationSandbox({
        orgId: f.orgId,
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
      })
      const handle = await sandbox.ensure()
      const send = async (source: string | undefined, prompt: string) => {
        const response = await f.request(`/conversations/${f.conversationId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [
              ...(await workspaceChatPersistence().stores.messages.loadThread(
                f.conversationId,
              )),
              { id: `user-${prompt}`, role: "user", content: prompt },
            ],
            tools: [],
            context: [],
            threadId: f.conversationId,
            runId: `${f.conversationId}-${prompt}`,
            forwardedProps: {
              workspaceId: f.workspaceId,
              ...(source ? { source } : {}),
            },
          }),
        })
        expect(await response.text()).toContain("RUN_FINISHED")
      }

      await send("ui", "From the UI")
      expect(await running(handle.id)).toBe(true)

      await send(undefined, "From an API caller")
      expect(await running(handle.id)).toBe(false)
      expect((await sandbox.row())?.state).toBe("stopped")
    })
  },
)

it(
  "an unattended run stops its sandbox when it fails or is abandoned, unless another turn holds it",
  { timeout: 120_000 },
  async () => {
    const previous = process.env.SANDBOX_CHAT_IMAGE
    try {
      await withNativeChatFixture(async (f) => {
        process.env.SANDBOX_PROVIDER = "docker"
        process.env.SANDBOX_CHAT_IMAGE = IMAGE
        const target = { orgId: f.orgId, conversationId: f.conversationId }
        const sandbox = conversationSandbox({
          orgId: f.orgId,
          workspaceId: f.workspaceId,
          conversationId: f.conversationId,
        })
        const turn: TanstackWorkspaceChatInput = {
          conversationId: f.conversationId,
          orgId: f.orgId,
          orgSlug: f.orgSlug,
          workspaceId: f.workspaceId,
          desiredUrl: f.directory,
          desiredSha: f.sha,
          defaultBranch: "main",
          writeStatus: "read_only",
          prompt: "Question",
        }
        /** Read until the sandbox is ready, then walk away. */
        const abandon = async (stream: AsyncIterable<StreamChunk>) => {
          for await (const chunk of stream)
            if (
              (chunk as { value?: { phase?: string } }).value?.phase === "ready"
            )
              break
        }

        await pullImage()
        const handle = await sandbox.ensure()
        await abandon(streamTanstackWorkspaceChat(turn))
        expect(await running(handle.id)).toBe(true)

        await abandon(
          stoppingSandboxWhenDone(target, streamTanstackWorkspaceChat(turn)),
        )
        expect(await running(handle.id)).toBe(false)
        expect((await sandbox.row())?.state).toBe("stopped")

        await sandbox.ensure()
        expect(await running(handle.id)).toBe(true)
        const failed = (async () => {
          for await (const _ of stoppingSandboxWhenDone(
            target,
            streamTanstackWorkspaceChat({ ...turn, desiredUrl: "" }),
          )) {
            // drain
          }
        })()
        await expect(failed).rejects.toThrow("workspace_required")
        expect(await running(handle.id)).toBe(false)

        // Another turn holds the conversation: its own end stops it.
        await sandbox.ensure()
        await postgresSandboxLocks(f.orgId).withLock(
          `chat-thread:${f.conversationId}`,
          () => stopConversationSandboxes(target),
        )
        expect(await running(handle.id)).toBe(true)
        await stopConversationSandboxes(target)
        expect(await running(handle.id)).toBe(false)
      })
    } finally {
      if (previous === undefined) delete process.env.SANDBOX_CHAT_IMAGE
      else process.env.SANDBOX_CHAT_IMAGE = previous
    }
  },
)

it("reading a file never creates a sandbox", { timeout: 60_000 }, async () => {
  await withNativeChatFixture(async (f) => {
    const response = await f.request(
      `/conversations/${f.conversationId}/files/blob?path=README.md`,
    )
    expect(response.status).toBe(409)
    const rows = await withOrgDbContext(f.orgId, (db) =>
      db
        .select()
        .from(workspaceSandboxInstances)
        .where(eq(workspaceSandboxInstances.conversationId, f.conversationId)),
    )
    expect(rows).toEqual([])
  })
})

it(
  "starts the idle clock when a turn ends, not when it starts",
  { timeout: 150_000 },
  async () => {
    let modelAnsweredAt = 0
    await withNativeChatFixture(
      async (f) => {
        const chunks: StreamChunk[] = []
        for await (const chunk of streamTanstackWorkspaceChat({
          conversationId: f.conversationId,
          orgId: f.orgId,
          orgSlug: f.orgSlug,
          workspaceId: f.workspaceId,
          desiredUrl: f.directory,
          desiredSha: f.sha,
          defaultBranch: "main",
          writeStatus: "read_only",
          prompt: "Question",
          runId: `${f.conversationId}-idle-clock`,
          messages: [
            { id: "user-idle-clock", role: "user", content: "Question" },
          ],
        }))
          chunks.push(chunk)
        expect(chunks.map((chunk) => chunk.type)).toContain("RUN_FINISHED")
        const [row] = await withOrgDbContext(f.orgId, (db) =>
          db
            .select()
            .from(workspaceSandboxInstances)
            .where(
              eq(workspaceSandboxInstances.conversationId, f.conversationId),
            ),
        )
        expect(modelAnsweredAt).toBeGreaterThan(0)
        expect(row?.lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(
          modelAnsweredAt,
        )
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        modelAnsweredAt = Date.now()
      },
    )
  },
)
