import { defineSandbox } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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
  INGESTION_V2_WORKFLOW_NAME,
  type IngestionV2RunInput,
} from "../ingestion/ingestion-run.js"
import {
  INGEST_SHARD_LIMIT_MS,
  ingestSandboxThreadId,
  ORG_INGEST_SANDBOX_LIMIT,
  ORG_RUNNING_SANDBOX_LIMIT,
} from "./chat-lifecycle.js"
import {
  SandboxCapacityError,
  sweepConversationSandboxes,
  withConversationSandboxSlots,
} from "./conversation-sandbox-lifecycle.js"
import { ingestSandbox } from "./ingest-sandbox.js"
import type { WorkspaceRevision } from "./revision.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import { destroySandboxesForWorkspace } from "./workspace-sandbox-cleanup.js"

const IMAGE = "alpine:3.22"

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest sandboxes")
  return url
}

beforeAll(() => {
  databaseUrl()
  initDb(databaseUrl())
})

afterAll(async () => {
  const { closeOpenWorkflowClient } = await import(
    "../../openworkflow/client.js"
  )
  await closeOpenWorkflowClient()
  await closeDb()
})

/** Real Postgres rows for an org and a Workspace. */
async function withOrg<T>(
  fn: (org: { orgId: string; workspaceId: string }) => Promise<T>,
): Promise<T> {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingest sandbox proof",
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

/** Running sandbox rows of other starts: `ingest` ingest rows, then chat rows. */
async function fillSlots(
  org: { orgId: string; workspaceId: string },
  counts: { ingest: number; chat: number },
) {
  const rows = [
    ...Array.from({ length: counts.ingest }, (_, index) => ({
      id: `full-ingest-${org.orgId}-${index}`,
      kind: "ingest",
      conversationId: `ingest:run_elsewhere:${index}`,
    })),
    ...Array.from({ length: counts.chat }, (_, index) => ({
      id: `full-chat-${org.orgId}-${index}`,
      kind: "chat",
      conversationId: `conv_elsewhere_${index}`,
    })),
  ]
  await withOrgDbContext(org.orgId, (db) =>
    db.insert(workspaceSandboxInstances).values(
      rows.map((row) => ({
        ...row,
        orgId: org.orgId,
        workspaceId: org.workspaceId,
        provider: "docker",
        providerSandboxId: `container-${row.id}`,
        state: "live",
        lastHeartbeatAt: new Date(),
      })),
    ),
  )
  return {
    remove: () =>
      withOrgDbContext(org.orgId, async (db) => {
        for (const row of rows)
          await db
            .delete(workspaceSandboxInstances)
            .where(eq(workspaceSandboxInstances.id, row.id))
      }),
  }
}

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
    id: "ingest-slot-proof-chat",
    provider: withConversationSandboxSlots(
      dockerSandbox({ image: IMAGE }),
      owner,
    ),
    lifecycle: { reuse: "thread", snapshot: "none", destroyOnComplete: false },
  })
  const ctx = {
    threadId: conversationId,
    runId: `run-${conversationId}`,
    store: postgresSandboxInstanceStore({
      ...owner,
      // The conversation row is not needed for a refused start.
      conversationId: undefined,
    }),
    locks: postgresSandboxLocks(org.orgId),
    tenant: { userId: undefined, orgId: org.orgId },
  }
  return { ensure: () => definition.ensure(ctx) }
}

describe("ingest sandbox slots (Postgres)", () => {
  it("refuses a chat start when the org runs 50 sandboxes, 40 of them ingest", async () => {
    await withOrg(async (org) => {
      const full = await fillSlots(org, {
        ingest: ORG_INGEST_SANDBOX_LIMIT,
        chat: ORG_RUNNING_SANDBOX_LIMIT - ORG_INGEST_SANDBOX_LIMIT,
      })
      try {
        await expect(chatSandbox(org).ensure()).rejects.toBeInstanceOf(
          SandboxCapacityError,
        )
      } finally {
        await full.remove()
      }
    })
  })

  it("makes an ingest start wait, with no row, while the org runs 50 sandboxes", async () => {
    await withOrg(async (org) => {
      const full = await fillSlots(org, {
        ingest: ORG_INGEST_SANDBOX_LIMIT - 10,
        chat: ORG_RUNNING_SANDBOX_LIMIT - ORG_INGEST_SANDBOX_LIMIT + 10,
      })
      const abort = new AbortController()
      const sandbox = ingestSandbox({
        ...org,
        runId: generateObjectId("run"),
        shard: 0,
        isolation: "docker",
        provider: dockerSandbox({ image: IMAGE }),
        image: IMAGE,
        signal: abort.signal,
        slotPollMs: 50,
      })
      try {
        const started = sandbox.ensure()
        const outcome = started.then(
          () => "started",
          (error: unknown) => error,
        )
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(await getSandboxInstance(sandbox.key, org.orgId)).toBeNull()
        // Whether the abort lands in the wait or in a start, the caller gets
        // the reason: it tells a cancelled step from an ended one.
        const reason = new Error("step ended")
        abort.abort(reason)
        expect(await outcome).toBe(reason)
        expect(await getSandboxInstance(sandbox.key, org.orgId)).toBeNull()
      } finally {
        await full.remove()
      }
    })
  })
  it("stops waiting at once when its signal was aborted before the start", async () => {
    await withOrg(async (org) => {
      const full = await fillSlots(org, {
        ingest: ORG_INGEST_SANDBOX_LIMIT,
        chat: 0,
      })
      try {
        const sandbox = ingestSandbox({
          ...org,
          runId: generateObjectId("run"),
          shard: 0,
          isolation: "docker",
          provider: dockerSandbox({ image: IMAGE }),
          image: IMAGE,
          signal: AbortSignal.abort(new Error("step ended")),
          slotPollMs: 50,
        })
        const outcome = await Promise.race([
          sandbox.ensure().then(
            () => "started",
            (error: unknown) => error,
          ),
          new Promise((resolve) => setTimeout(() => resolve("waiting"), 2_000)),
        ])
        expect(outcome).toBeInstanceOf(Error)
        expect(await getSandboxInstance(sandbox.key, org.orgId)).toBeNull()
      } finally {
        await full.remove()
      }
    })
  })
})

describe("ingest sandbox sweep (Postgres, unsandboxed)", () => {
  /** An unsandboxed ingest shard: a real local process sandbox, no slots. */
  function localIngest(
    org: { orgId: string; workspaceId: string },
    runId: string,
  ) {
    return ingestSandbox({
      ...org,
      runId,
      shard: 3,
      isolation: "unsandboxed",
      provider: localProcessSandbox(),
      image: "local",
    })
  }

  /** A real OpenWorkflow run of the org that has not finished. */
  async function withUnfinishedRun<T>(
    orgId: string,
    fn: (runId: string) => Promise<T>,
    workflowName: string = INGESTION_V2_WORKFLOW_NAME,
  ): Promise<T> {
    const backend = await BackendPostgres.connect(databaseUrl(), {
      runMigrations: false,
      namespaceId: openWorkflowNamespaceId(),
    })
    try {
      const run = await backend.createWorkflowRun({
        workflowName,
        version: null,
        idempotencyKey: null,
        config: {},
        context: null,
        input: { orgId, shadow: true } satisfies IngestionV2RunInput,
        parentStepAttemptNamespaceId: null,
        parentStepAttemptId: null,
        // Never due: no worker claims it.
        availableAt: new Date(Date.now() + 365 * 24 * 60 * 60_000),
        deadlineAt: null,
      })
      try {
        return await fn(run.id)
      } finally {
        await backend.cancelWorkflowRun({ workflowRunId: run.id })
      }
    } finally {
      await backend.stop()
    }
  }

  it("keys the shard's sandbox by its run and shard, and keeps the row as ingest", async () => {
    await withOrg(async (org) => {
      const runId = generateObjectId("run")
      const sandbox = localIngest(org, runId)
      expect(sandbox.threadId).toBe(ingestSandboxThreadId(runId, 3))
      expect(sandbox.threadId).toBe(`ingest:${runId}:3`)
      const handle = await sandbox.ensure()
      const row = await getSandboxInstance(sandbox.key, org.orgId)
      expect(row).toMatchObject({
        kind: "ingest",
        conversationId: `ingest:${runId}:3`,
        latestRunId: runId,
        provider: "local-process",
        providerSandboxId: handle.id,
        state: "live",
      })
      expect((await sandbox.ensure()).id).toBe(handle.id)
      await sandbox.destroy()
      expect(await getSandboxInstance(sandbox.key, org.orgId)).toBeNull()
    })
  })

  it("deletes an orphan ingest sandbox: its run is unknown", async () => {
    await withOrg(async (org) => {
      const sandbox = localIngest(org, generateObjectId("run"))
      const handle = await sandbox.ensure()
      await handle.process.exec("printf kept > kept.txt")

      const swept = await sweepConversationSandboxes(org.orgId)
      expect(swept.deleted).toBe(1)
      expect(await getSandboxInstance(sandbox.key, org.orgId)).toBeNull()
      expect(await sandbox.ensureExisting()).toBeNull()
    })
  })

  it("keeps the sandbox of an unfinished run until the shard limit, then deletes it", async () => {
    await withOrg(async (org) => {
      await withUnfinishedRun(org.orgId, async (runId) => {
        const sandbox = localIngest(org, runId)
        await sandbox.ensure()
        const row = await getSandboxInstance(sandbox.key, org.orgId)
        const startedAt = row?.createdAt?.getTime()
        if (!startedAt) throw new Error("ingest row missing")

        expect(await sweepConversationSandboxes(org.orgId)).toEqual({
          stopped: 0,
          deleted: 0,
          nextSweepAt: new Date(startedAt + INGEST_SHARD_LIMIT_MS),
        })
        expect(await getSandboxInstance(sandbox.key, org.orgId)).not.toBeNull()

        const late = new Date(startedAt + INGEST_SHARD_LIMIT_MS)
        // A step that holds the shard lock keeps its sandbox.
        await postgresSandboxLocks(org.orgId).withLock(
          sandbox.threadId,
          async () => {
            const busy = await sweepConversationSandboxes(org.orgId, late)
            expect(busy.deleted).toBe(0)
            expect(busy.nextSweepAt?.getTime()).toBeGreaterThan(late.getTime())
          },
        )
        expect(
          (await sweepConversationSandboxes(org.orgId, late)).deleted,
        ).toBe(1)
        expect(await getSandboxInstance(sandbox.key, org.orgId)).toBeNull()
      })
    })
  })

  it("deletes the sandbox once its run has finished", async () => {
    await withOrg(async (org) => {
      let sandbox: ReturnType<typeof localIngest> | undefined
      await withUnfinishedRun(org.orgId, async (runId) => {
        sandbox = localIngest(org, runId)
        await sandbox.ensure()
        expect((await sweepConversationSandboxes(org.orgId)).deleted).toBe(0)
      })
      if (!sandbox) throw new Error("sandbox missing")
      // The run is cancelled now.
      expect((await sweepConversationSandboxes(org.orgId)).deleted).toBe(1)
      expect(await getSandboxInstance(sandbox.key, org.orgId)).toBeNull()
    })
  })

  it("does not keep a sandbox alive for an unfinished run of another org", async () => {
    await withOrg(async (org) => {
      await withUnfinishedRun(generateObjectId("org"), async (runId) => {
        const sandbox = localIngest(org, runId)
        await sandbox.ensure()
        expect((await sweepConversationSandboxes(org.orgId)).deleted).toBe(1)
      })
    })
  })

  it("does not keep a sandbox alive for an unfinished run of another workflow", async () => {
    await withOrg(async (org) => {
      await withUnfinishedRun(
        org.orgId,
        async (runId) => {
          const sandbox = localIngest(org, runId)
          await sandbox.ensure()
          expect((await sweepConversationSandboxes(org.orgId)).deleted).toBe(1)
        },
        "conversation-sandbox-sweep",
      )
    })
  })

  it("refuses a sandbox for a Workspace of another org", async () => {
    await withOrg(async (org) => {
      await withOrg(async (other) => {
        const sandbox = ingestSandbox({
          orgId: org.orgId,
          workspaceId: other.workspaceId,
          runId: generateObjectId("run"),
          shard: 0,
          isolation: "docker",
          provider: dockerSandbox({ image: IMAGE }),
          image: IMAGE,
        })
        await expect(sandbox.ensure()).rejects.toThrow(/Workspace/)
        expect(await getSandboxInstance(sandbox.key, org.orgId)).toBeNull()
        expect(await getSandboxInstance(sandbox.key, other.orgId)).toBeNull()
      })
    })
  })
})
