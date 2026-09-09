import {
  createSecrets,
  defineSandbox,
  memorySandboxSnapshots,
  type SandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { runSandboxInstanceStoreConformance } from "@tanstack/ai-sandbox/testkit"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { WORKSPACE_CHAT_DOCKER_SANDBOX } from "./chat-runtime.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"

const fixtures: Array<{ orgId: string; workspaceId: string }> = []

beforeAll(() => {
  const url = process.env.DATABASE_URL
  if (!url)
    throw new Error(
      "DATABASE_URL is required for native sandbox ownership proof",
    )
  initDb(url)
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await withOrgDbContext(fixture.orgId, (db) =>
      db.delete(workspaces).where(eq(workspaces.id, fixture.workspaceId)),
    )
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, fixture.orgId))
  }
})

afterAll(closeDb)

async function makeStore() {
  const orgId = generateObjectId("org")
  const workspaceId = generateObjectId("ws")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Native sandbox ownership",
    createdAt: new Date(),
  })
  fixtures.push({ orgId, workspaceId })
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: "context",
      displayName: "Context",
      workspaceRepositoryUrl: "https://example.test/context.git",
    }),
  )
  return postgresSandboxInstanceStore({
    orgId,
    workspaceId,
  })
}

runSandboxInstanceStoreConformance("native Postgres", makeStore)

const original: SandboxInstanceRecord = {
  key: "revision-a",
  provider: "docker",
  providerSandboxId: "container-a",
  threadId: "thread-1",
  latestSnapshotId: "snapshot-a",
  updatedAt: 1,
}

it("does not attach another revision when an exact sandbox key is absent", async () => {
  const store = await makeStore()
  await store.upsert(original)
  expect(await store.get("revision-b")).toBeNull()
})

it("keeps native identities for two revisions of the same thread distinct", async () => {
  const store = await makeStore()
  await store.upsert(original)
  const next = {
    ...original,
    key: "revision-b",
    providerSandboxId: "container-b",
    latestSnapshotId: "snapshot-b",
  }
  await store.upsert(next)
  expect(await store.get(original.key)).toEqual(original)
  expect(await store.get(next.key)).toEqual(next)
})

it("one static definition isolates runtime bindings, rotates secrets and saves the selected workspace", async () => {
  const store = await makeStore()
  const fixture = fixtures.at(-1)
  if (!fixture) throw new Error("Native ownership fixture missing")
  const locks = postgresSandboxLocks(fixture.orgId)
  const definition = defineSandbox({
    id: "static-runtime-workspace",
    provider: localProcessSandbox(),
    lifecycle: { reuse: "thread", snapshot: "none" },
  })
  const common = {
    threadId: "same-thread",
    runId: "runtime-binding",
    store,
    locks,
    tenant: { orgId: fixture.orgId },
  }
  const workspace = {
    identity: "revision-a",
    source: { type: "none" as const },
    setup: ["printf '%s' 'native bound workspace' > marker.txt"],
    secrets: createSecrets({ FIXTURE_TOKEN: "credential-a" }),
  }
  const a = { ...common, workspace }
  const b = {
    ...common,
    workspace: {
      ...workspace,
      identity: "revision-b",
      secrets: createSecrets({ FIXTURE_TOKEN: "credential-b" }),
    },
  }
  try {
    expect(definition.key(a)).not.toBe(definition.key(b))
    const [first, second] = await Promise.all([
      definition.ensure(a),
      definition.ensure(b),
    ])
    expect(first.id).not.toBe(second.id)
    await first.fs.write("/workspace/marker.txt", "first binding edit")
    expect(await second.fs.read("/workspace/marker.txt")).toBe(
      "native bound workspace",
    )
    const rotated = {
      ...a,
      workspace: {
        ...workspace,
        secrets: createSecrets({ FIXTURE_TOKEN: "credential-c" }),
      },
    }
    const resumed = await definition.ensureExisting(rotated)
    expect(resumed?.id).toBe(first.id)
    expect(
      (await resumed?.process.exec("printenv FIXTURE_TOKEN"))?.stdout.trim(),
    ).toBe("credential-c")
    expect(
      (await second.process.exec("printenv FIXTURE_TOKEN")).stdout.trim(),
    ).toBe("credential-b")
    const snapshotInput = {
      sandbox: definition,
      instances: store,
      locks,
      tenant: common.tenant,
      workspace: rotated.workspace,
    }
    const snapshots = await memorySandboxSnapshots(snapshotInput)
    const checkpoint = await snapshots.save({
      threadId: common.threadId,
      runId: "named",
      label: "selected revision",
    })
    const file = checkpoint.files.find((entry) => entry.path === "marker.txt")
    if (file?.kind !== "file")
      throw new Error("Named snapshot omitted the selected workspace")
    const blob = await snapshots.persistence.stores.blobs.get(file.blobKey)
    expect(new TextDecoder().decode(await blob?.arrayBuffer())).toBe(
      "first binding edit",
    )
    await definition.destroy(a)
    expect(await definition.ensureExisting(a)).toBeNull()
    expect(await second.fs.read("/workspace/marker.txt")).toBe(
      "native bound workspace",
    )
  } finally {
    await definition.destroy(a)
    await definition.destroy(b)
  }
})

it(
  "cancels an in-flight native Docker filesystem write before a new owner can use the worktree",
  { timeout: 30_000 },
  async () => {
    const provider = dockerSandbox(WORKSPACE_CHAT_DOCKER_SANDBOX)
    const handle = await provider.create({
      workspace: { source: { type: "none" } },
    })
    const controller = new AbortController()
    let settled = false
    let failure = ""
    try {
      expect((await handle.process.exec("mkfifo blocked-write")).exitCode).toBe(
        0,
      )
      const pending = handle.fs
        .write("/workspace/blocked-write", "must not survive lease loss", {
          signal: controller.signal,
        })
        .then(
          () => {
            settled = true
            return "completed"
          },
          (error) => {
            settled = true
            failure = String(error)
            return "aborted"
          },
        )
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(settled, failure).toBe(false)
      controller.abort(new Error("Native ownership lost"))
      await expect.poll(() => settled, { timeout: 5_000 }).toBe(true)
      expect(await pending).toBe("aborted")
      const observed = await handle.process.exec("timeout 1 cat blocked-write")
      expect(observed.stdout).toBe("")
      expect(observed.exitCode).toBe(124)
      const valid = new AbortController()
      await handle.fs.write(
        "relative-notes.md",
        "A subsequent owner can write",
        { signal: valid.signal },
      )
      expect(
        await handle.fs.read("relative-notes.md", { signal: valid.signal }),
      ).toBe("A subsequent owner can write")
      await handle.fs.remove("relative-notes.md", { signal: valid.signal })
    } finally {
      controller.abort()
      await handle.destroy()
    }
  },
)
