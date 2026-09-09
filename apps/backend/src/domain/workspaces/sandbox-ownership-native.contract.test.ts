import type { SandboxInstanceRecord } from "@tanstack/ai-sandbox"
import { runSandboxInstanceStoreConformance } from "@tanstack/ai-sandbox/testkit"
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
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"

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
