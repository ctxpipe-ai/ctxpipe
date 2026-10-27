import { defineSandbox } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import Docker from "dockerode"
import { eq } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { getSandboxInstance } from "../../models/workspaces.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import {
  INGEST_SHARD_LIMIT_MS,
  ORG_INGEST_SANDBOX_LIMIT,
} from "./chat-lifecycle.js"
import { withConversationSandboxSlots } from "./conversation-sandbox-lifecycle.js"
import { ingestSandbox } from "./ingest-sandbox.js"
import type { WorkspaceRevision } from "./revision.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { destroySandboxesForWorkspace } from "./workspace-sandbox-cleanup.js"

const IMAGE = "alpine:3.22"
const docker = new Docker({ timeout: 30_000 })

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest sandboxes")
  return url
}

beforeAll(async () => {
  initDb(databaseUrl())
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
}, 120_000)

afterAll(async () => {
  const { closeOpenWorkflowClient } =
    await import("../../openworkflow/client.js")
  await closeOpenWorkflowClient()
  await closeDb()
})

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
    namespaceId: openWorkflowNamespaceId(),
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

/** Real Postgres rows for an org and a Workspace. */
async function withOrg<T>(
  fn: (org: { orgId: string; workspaceId: string }) => Promise<T>,
): Promise<T> {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingest sandbox contract",
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
    return await fn({ orgId, workspaceId })
  } finally {
    await withOrgIdContext({ id: orgId, slug: orgId }, () =>
      destroySandboxesForWorkspace(workspaceId),
    )
    await withOrgDbContext(orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.orgId, orgId)),
    )
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  }
}

function dockerIngest(
  org: { orgId: string; workspaceId: string },
  runId: string,
  shard: number,
) {
  return ingestSandbox({
    ...org,
    runId,
    shard,
    isolation: "docker",
    provider: dockerSandbox({ image: IMAGE }),
    image: IMAGE,
    slotPollMs: 100,
  })
}

it(
  "creates the shard's Docker sandbox, attaches to it, and creates it again after a kill",
  { timeout: 120_000 },
  async () => {
    await withOrg(async (org) => {
      const runId = generateObjectId("run")
      const sandbox = dockerIngest(org, runId, 0)

      const created = await sandbox.ensure()
      expect(await running(created.id)).toBe(true)
      await created.process.exec("printf kept > /tmp/kept.txt")
      const row = await getSandboxInstance(sandbox.key, org.orgId)
      expect(row).toMatchObject({
        kind: "ingest",
        conversationId: `ingest:${runId}:0`,
        latestRunId: runId,
        provider: "docker",
        providerSandboxId: created.id,
        state: "live",
      })
      // The sweep is due at the shard limit, also if no later step comes.
      const startedAt = row?.createdAt?.getTime() ?? 0
      expect(await queuedSweeps(org.orgId)).toContain(
        Math.ceil((startedAt + INGEST_SHARD_LIMIT_MS) / 60_000) * 60_000,
      )

      const attached = await sandbox.ensure()
      expect(attached.id).toBe(created.id)
      expect(
        (await attached.process.exec("cat /tmp/kept.txt")).stdout.trim(),
      ).toBe("kept")

      await docker.getContainer(created.id).remove({ force: true })
      const recreated = await sandbox.ensure()
      expect(recreated.id).not.toBe(created.id)
      expect(await running(recreated.id)).toBe(true)
      expect(await getSandboxInstance(sandbox.key, org.orgId)).toMatchObject({
        kind: "ingest",
        providerSandboxId: recreated.id,
        state: "live",
      })

      await sandbox.destroy()
      expect(await running(recreated.id)).toBe("gone")
      expect(await getSandboxInstance(sandbox.key, org.orgId)).toBeNull()
    })
  },
)

it(
  "makes the 41st ingest start wait while a chat start still succeeds",
  { timeout: 120_000 },
  async () => {
    await withOrg(async (org) => {
      const ids = Array.from(
        { length: ORG_INGEST_SANDBOX_LIMIT },
        (_, index) => `full-ingest-${org.orgId}-${index}`,
      )
      await withOrgDbContext(org.orgId, (db) =>
        db.insert(workspaceSandboxInstances).values(
          ids.map((id, index) => ({
            id,
            kind: "ingest",
            orgId: org.orgId,
            workspaceId: org.workspaceId,
            conversationId: `ingest:run_elsewhere:${index}`,
            provider: "docker",
            providerSandboxId: `container-${id}`,
            state: "live",
            lastHeartbeatAt: new Date(),
          })),
        ),
      )
      const removeFill = (id: string) =>
        withOrgDbContext(org.orgId, (db) =>
          db
            .delete(workspaceSandboxInstances)
            .where(eq(workspaceSandboxInstances.id, id)),
        )
      try {
        const ingest = dockerIngest(org, generateObjectId("run"), 7)
        let started: string | undefined
        const pending = ingest.ensure().then((handle) => {
          started = handle.id
          return handle
        })
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        expect(started).toBeUndefined()
        expect(await getSandboxInstance(ingest.key, org.orgId)).toBeNull()

        // Chat keeps its 10 slots.
        const chat = await chatSandbox(org).ensure()
        expect(await running(chat.id)).toBe(true)

        await removeFill(ids[0] ?? "")
        const handle = await pending
        expect(await running(handle.id)).toBe(true)
        expect(await getSandboxInstance(ingest.key, org.orgId)).toMatchObject({
          kind: "ingest",
          providerSandboxId: handle.id,
        })
      } finally {
        for (const id of ids) await removeFill(id)
      }
    })
  },
)

/** A chat start as chat builds it, behind the org's slots. */
function chatSandbox(org: { orgId: string; workspaceId: string }) {
  const conversationId = generateObjectId("conv")
  const revision: WorkspaceRevision = {
    workspaceId: org.workspaceId,
    remote: { url: "https://example.test/context.git", connectionId: null },
    sha: "a".repeat(40),
    generation: 1,
    defaultBranch: "main",
    access: "read",
  }
  const owner = {
    ...org,
    conversationId,
    provider: "docker" as const,
    image: IMAGE,
    revision,
  }
  const definition = defineSandbox({
    id: "ingest-slot-contract-chat",
    provider: withConversationSandboxSlots(
      dockerSandbox({ image: IMAGE }),
      owner,
    ),
    lifecycle: { reuse: "thread", snapshot: "none", destroyOnComplete: false },
  })
  const ctx = {
    threadId: conversationId,
    runId: `run-${conversationId}`,
    // No conversation row: the store checks only the sandbox row here.
    store: postgresSandboxInstanceStore({
      ...owner,
      conversationId: undefined,
    }),
    locks: postgresSandboxLocks(org.orgId),
    tenant: { userId: undefined, orgId: org.orgId },
  }
  return { ensure: () => definition.ensure(ctx) }
}
