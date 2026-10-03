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
import { withNativeChatFixture } from "../../test/native-chat-fixture.js"
import {
  CHAT_SANDBOX_IDLE_STOP_MS,
  CHAT_SANDBOX_RETENTION_MS,
  ORG_RUNNING_SANDBOX_LIMIT,
} from "./chat-lifecycle.js"
import {
  SandboxCapacityError,
  stopConversationSandboxes,
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
import { destroySandboxesForWorkspace } from "./workspace-sandbox-cleanup.js"

const IMAGE = "alpine:3.22"
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
}) {
  const revision: WorkspaceRevision = {
    workspaceId: input.workspaceId,
    remote: { url: "https://example.test/context.git", connectionId: null },
    sha: "a".repeat(40),
    generation: 1,
    defaultBranch: "main",
    access: "read",
  }
  const owner = {
    ...input,
    provider: "docker" as const,
    image: IMAGE,
    revision,
  }
  const definition = defineSandbox({
    id: "sandbox-lifecycle-proof",
    provider: withConversationSandboxSlots(
      dockerSandbox({ image: IMAGE, workdir: "/tmp" }),
      owner,
    ),
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
    key: definition.key(ctx),
    ensure: () => definition.ensure(ctx),
    row: () => getSandboxInstance(definition.key(ctx), input.orgId),
  }
}

/** Fill the org's slots with other running conversation sandboxes. */
async function fillSlots(orgId: string, workspaceId: string, count: number) {
  const ids = Array.from(
    { length: count },
    (_, index) => `full-${orgId}-${index}`,
  )
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaceSandboxInstances).values(
      ids.map((id) => ({
        id,
        kind: "chat",
        orgId,
        workspaceId,
        conversationId: `conv_elsewhere_${id}`,
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

      const early = await sweepConversationSandboxes(
        org.orgId,
        new Date(lastUse + CHAT_SANDBOX_IDLE_STOP_MS - 1_000),
      )
      expect(early).toEqual({
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
            nextSweepAt: new Date(idleAt.getTime() + 60_000),
          })
        },
      )
      expect(await running(handle.id)).toBe(true)

      expect(await sweepConversationSandboxes(org.orgId, idleAt)).toEqual({
        stopped: 1,
        deleted: 0,
        nextSweepAt: new Date(lastUse + CHAT_SANDBOX_RETENTION_MS),
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

      // Each start scheduled the org's sweep for when the sandbox is idle.
      const backend = await BackendPostgres.connect(databaseUrl(), {
        runMigrations: false,
      })
      try {
        const sweeps = (await backend.listWorkflowRuns({ limit: 500 })).data
          .filter(
            (run) =>
              run.workflowName === "conversation-sandbox-sweep" &&
              (run.input as { orgId?: string })?.orgId === org.orgId,
          )
          .map((run) => run.availableAt?.getTime() ?? 0)
        expect(sweeps.length).toBeGreaterThanOrEqual(1)
        for (const at of sweeps)
          expect(at).toBeGreaterThanOrEqual(lastUse + CHAT_SANDBOX_IDLE_STOP_MS)
      } finally {
        await backend.stop()
      }
    })
  },
)

it(
  "deletes a sandbox and its saved state 30 days after last use, or once its conversation is gone",
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
      const now = new Date()
      const lastUse = (await kept.row())?.lastHeartbeatAt.getTime() ?? 0
      expect(await sweepConversationSandboxes(org.orgId, now)).toEqual({
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
          new Date(lastUse + CHAT_SANDBOX_RETENTION_MS - 1_000),
        ),
      ).toEqual({
        stopped: 0,
        deleted: 0,
        nextSweepAt: new Date(lastUse + CHAT_SANDBOX_RETENTION_MS),
      })
      expect(
        await sweepConversationSandboxes(
          org.orgId,
          new Date(lastUse + CHAT_SANDBOX_RETENTION_MS),
        ),
      ).toEqual({ stopped: 0, deleted: 1, nextSweepAt: null })
      expect(await kept.row()).toBeNull()
      expect(await running(keptHandle.id)).toBe("gone")
    })
  },
)

it(
  "refuses a new or resumed sandbox when the org already runs 50, counting only running ones",
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
        await full.setState(0, "stopped")
        const handle = await sandbox.ensure()
        expect(await running(handle.id)).toBe(true)

        expect(
          await stopConversationSandboxes({ orgId: org.orgId, conversationId }),
        ).toEqual({ stopped: 1 })
        expect(await running(handle.id)).toBe(false)

        // Resuming takes a slot too.
        await full.setState(0, "live")
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

          const sent = await f.request(`/conversations/${f.conversationId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              messages: [{ id: "user-full", role: "user", content: "Hello" }],
              tools: [],
              context: [],
              threadId: f.conversationId,
              runId: `${f.conversationId}-full`,
              forwardedProps: { workspaceId: f.workspaceId },
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
  "an unattended run stops its sandbox when it fails or is abandoned; an interactive one keeps it",
  { timeout: 120_000 },
  async () => {
    const previous = process.env.SANDBOX_CHAT_IMAGE
    try {
      await withNativeChatFixture(async (f) => {
        process.env.SANDBOX_PROVIDER = "docker"
        process.env.SANDBOX_CHAT_IMAGE = IMAGE
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
        const abandon = async (input: TanstackWorkspaceChatInput) => {
          for await (const chunk of streamTanstackWorkspaceChat(input))
            if (
              (chunk as { value?: { phase?: string } }).value?.phase === "ready"
            )
              break
        }

        await pullImage()
        const handle = await sandbox.ensure()
        await abandon(turn)
        expect(await running(handle.id)).toBe(true)

        await abandon({ ...turn, stopSandboxWhenDone: true })
        expect(await running(handle.id)).toBe(false)
        expect((await sandbox.row())?.state).toBe("stopped")

        await sandbox.ensure()
        expect(await running(handle.id)).toBe(true)
        const failed = (async () => {
          for await (const _ of streamTanstackWorkspaceChat({
            ...turn,
            desiredUrl: "",
            stopSandboxWhenDone: true,
          })) {
            // drain
          }
        })()
        await expect(failed).rejects.toThrow("workspace_required")
        expect(await running(handle.id)).toBe(false)

        // Another turn holds the conversation: its own end stops it.
        await sandbox.ensure()
        await postgresSandboxLocks(f.orgId).withLock(
          `chat-thread:${f.conversationId}`,
          async () => {
            expect(
              await stopConversationSandboxes({
                orgId: f.orgId,
                conversationId: f.conversationId,
              }),
            ).toEqual({ busy: true })
          },
        )
        expect(await running(handle.id)).toBe(true)
        expect(
          await stopConversationSandboxes({
            orgId: f.orgId,
            conversationId: f.conversationId,
          }),
        ).toEqual({ stopped: 1 })
        expect(await running(handle.id)).toBe(false)
      })
    } finally {
      if (previous === undefined) delete process.env.SANDBOX_CHAT_IMAGE
      else process.env.SANDBOX_CHAT_IMAGE = previous
    }
  },
)

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
