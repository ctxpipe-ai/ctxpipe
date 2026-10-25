import { eq } from "drizzle-orm"
import { FalkorDB } from "falkordb"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  closeGraphDb,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import {
  collectInactiveWorkspaceGraphKeys,
  inactiveGraceMs,
  loadWorkspaceGraphKeysInUse,
  workspaceGraphKeys,
} from "./graph-gc.js"
import {
  hasWorkspaceGraph,
  readWorkspaceGraph,
  workspaceGraphRevisionKey,
  writeWorkspaceRevisionGraph,
} from "./graph-projection.js"
import type { HydrateUnit } from "./hydrate.js"
import type { ProjectionState, WorkspaceRevision } from "./revision.js"

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
// Each test has its own graph, so a key from one test is never "unused" in another.
let org = { orgId: "", orgSlug: "acme" }
let testNumber = 0
const graceMs = inactiveGraceMs
const t0 = new Date("2026-03-01T00:00:00.000Z")
const afterGrace = new Date(t0.getTime() + graceMs + 1000)
let falkor: FalkorDB

beforeAll(async () => {
  if (!process.env.GRAPH_DB_URI)
    throw new Error("GRAPH_DB_URI is required for the FalkorDB proof")
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for the Postgres proof")
  initDb(process.env.DATABASE_URL)
  falkor = await FalkorDB.connect({ url: process.env.GRAPH_DB_URI })
})

beforeEach(() => {
  testNumber += 1
  org = { orgId: `org_test_graph_gc_${suffix}_${testNumber}`, orgSlug: "acme" }
})

afterEach(async () => {
  if ((await falkor.list()).includes(org.orgId))
    await falkor.selectGraph(org.orgId).delete()
})

afterAll(async () => {
  if (!falkor) return
  await falkor.close()
  await closeGraphDb()
  await closeDb()
})

function revision(workspaceId: string, sha: string): WorkspaceRevision {
  return {
    workspaceId,
    generation: 1,
    remote: { url: "https://git.example.test/acme/kb.git", connectionId: null },
    defaultBranch: "main",
    sha: sha.repeat(40),
    access: "read",
  }
}

const units = [
  {
    path: "a.md",
    servingId: "ku_a",
    kind: null,
    body: "# a\n",
    links: ["b.md"],
    claims: [],
    title: "a",
    source: "authored",
    updatedAt: null,
  },
  {
    path: "b.md",
    servingId: "ku_b",
    kind: null,
    body: "# b\n",
    links: [],
    claims: [],
    title: "b",
    source: "authored",
    updatedAt: null,
  },
] satisfies HydrateUnit[]

const write = (rev: WorkspaceRevision) =>
  withGraphClient(org, () =>
    writeWorkspaceRevisionGraph(getGraphClient(), { revision: rev, units }),
  )

async function count(rev: WorkspaceRevision, label: string) {
  const result = await falkor
    .selectGraph(org.orgId)
    .query<{ n: number }>(
      `MATCH (n:${label} {projectionKey: $key}) RETURN count(n) AS n`,
      { params: { key: workspaceGraphRevisionKey(rev) } },
    )
  return Number(result.data?.[0]?.n ?? 0)
}

async function edges(rev: WorkspaceRevision) {
  const result = await falkor
    .selectGraph(org.orgId)
    .query<{ n: number }>(
      "MATCH ()-[r:WorkspaceSignal {projectionKey: $key}]->() RETURN count(r) AS n",
      { params: { key: workspaceGraphRevisionKey(rev) } },
    )
  return Number(result.data?.[0]?.n ?? 0)
}

const hasGraph = async (rev: WorkspaceRevision) =>
  (await count(rev, "WorkspaceProjection")) === 1 &&
  (await count(rev, "WorkspaceKnowledgeUnit")) === 2 &&
  (await edges(rev)) === 1

const none = async (rev: WorkspaceRevision) =>
  (await count(rev, "WorkspaceProjection")) === 0 &&
  (await count(rev, "WorkspaceKnowledgeUnit")) === 0 &&
  (await edges(rev)) === 0

function state(rev: WorkspaceRevision): ProjectionState {
  return {
    kind: "active",
    revision: rev,
    stores: {
      embeddings: { kind: "ready" },
      graph: { kind: "ready" },
      index: { kind: "ready" },
    },
  }
}

const keysOf = (...states: ProjectionState[]): ReadonlySet<string> =>
  new Set(states.flatMap(workspaceGraphKeys))

const gc = (use: () => Promise<ReadonlySet<string>>, now: Date) =>
  collectInactiveWorkspaceGraphKeys({ ...org, loadUse: use, now })

/** Leave the nodes of a revision without its completion marker, as a write that stopped early does. */
const dropMarker = (rev: WorkspaceRevision) =>
  falkor
    .selectGraph(org.orgId)
    .query("MATCH (p:WorkspaceProjection {projectionKey: $key}) DELETE p", {
      params: { key: workspaceGraphRevisionKey(rev) },
    })

it("removes an old key after the grace period, keeps the served key, and removes nothing on a second run", async () => {
  const id = `ws_old_${suffix}`
  const oldRev = revision(id, "a")
  const served = revision(id, "b")
  await write(oldRev)
  await write(served)
  const use = async () => keysOf(state(served))

  // The first run only marks the old key.
  expect(await gc(use, t0)).toEqual({ removed: 0 })
  expect(await hasGraph(oldRev)).toBe(true)
  // A run inside the grace period keeps it.
  expect(await gc(use, new Date(t0.getTime() + graceMs - 1000))).toEqual({
    removed: 0,
  })
  expect(await hasGraph(oldRev)).toBe(true)

  expect(await gc(use, afterGrace)).toEqual({ removed: 1 })
  expect(await none(oldRev)).toBe(true)
  expect(await hasGraph(served)).toBe(true)
  // The Workspace still serves its graph.
  const graph = await readWorkspaceGraph({
    ...org,
    projection: state(served) as Extract<ProjectionState, { kind: "active" }>,
  })
  expect(graph.nodes).toHaveLength(2)

  expect(await gc(use, afterGrace)).toEqual({ removed: 0 })
  expect(await hasGraph(served)).toBe(true)
})

it("keeps the served key and the key that a rebuild writes, even when they are old", async () => {
  const id = `ws_cap_${suffix}`
  const previous = revision(id, "c")
  const desired = revision(id, "d")
  await write(previous)
  await write(desired)
  // A new revision is building: the previous one still serves and the desired one is written.
  const building: ProjectionState = {
    kind: "building",
    desired,
    previous: state(previous) as Extract<ProjectionState, { kind: "active" }>,
  }
  const use = async () => keysOf(building)
  await gc(use, t0)
  expect(await gc(use, afterGrace)).toEqual({ removed: 0 })
  expect(await hasGraph(previous)).toBe(true)
  expect(await hasGraph(desired)).toBe(true)
})

it("clears the mark of a key that comes back into use before the grace period ends", async () => {
  const id = `ws_back_${suffix}`
  const first = revision(id, "e")
  const second = revision(id, "f")
  await write(first)
  await write(second)
  let served = second
  const use = async () => keysOf(state(served))
  await gc(use, t0) // marks the first key
  served = first
  await gc(use, new Date(t0.getTime() + 1000)) // the first key is in use: no mark
  served = second
  // The mark restarts here, so a run just after the first mark's grace keeps the key.
  await gc(use, new Date(t0.getTime() + 2000))
  expect(await gc(use, afterGrace)).toEqual({ removed: 0 })
  expect(await hasGraph(first)).toBe(true)
})

it("keeps a key that a Workspace adopts between two removals of one run", async () => {
  const id = `ws_race_${suffix}`
  const old = [revision(id, "1"), revision(id, "2")]
  const served = revision(id, "3")
  for (const rev of [...old, served]) await write(rev)
  await gc(async () => keysOf(state(served)), t0)
  // The first read of the run and the read before the first removal show no
  // use. The read before the second removal shows that the Workspace adopted
  // both old keys.
  let reads = 0
  const adopting = async () => {
    reads += 1
    return reads <= 2 ? keysOf(state(served)) : keysOf(...old.map(state))
  }
  expect(await gc(adopting, afterGrace)).toEqual({ removed: 1 })
  const gone = [await none(old[0] as WorkspaceRevision)]
  gone.push(await none(old[1] as WorkspaceRevision))
  expect(gone.filter(Boolean)).toHaveLength(1)
  expect(await hasGraph(served)).toBe(true)
  expect(
    (await hasGraph(old[0] as WorkspaceRevision)) ||
      (await hasGraph(old[1] as WorkspaceRevision)),
  ).toBe(true)
})

it("keeps a key that a Workspace adopts between the mark and the removal", async () => {
  const id = `ws_adopt_${suffix}`
  const served = revision(id, "4")
  const adopted = revision(id, "5")
  await write(served)
  await write(adopted)
  await gc(async () => keysOf(state(served)), t0)
  let reads = 0
  const adopting = async () => {
    reads += 1
    return keysOf(state(reads === 1 ? served : adopted))
  }
  // The first read marks nothing new and finds the key due. The second read
  // shows the adoption, so the key stays.
  expect(await gc(adopting, afterGrace)).toEqual({ removed: 0 })
  expect(await hasGraph(adopted)).toBe(true)
})

it("removes the keys of a Workspace that no longer exists, in bounded batches", async () => {
  const gone = Array.from({ length: 22 }, (_, i) =>
    revision(`ws_gone_${i}_${suffix}`, "6"),
  )
  for (const rev of gone) await write(rev)
  const use = async () => keysOf()
  await gc(use, t0)
  expect(await gc(use, afterGrace)).toEqual({ removed: 20 })
  // The next run finishes the work, and a later run removes nothing.
  expect(await gc(use, afterGrace)).toEqual({ removed: 2 })
  expect(await gc(use, afterGrace)).toEqual({ removed: 0 })
  for (const rev of gone) expect(await none(rev)).toBe(true)
})

it("removes the nodes of a write that stopped before its marker, after the grace period", async () => {
  const id = `ws_crash_${suffix}`
  const stopped = revision(id, "7")
  const served = revision(id, "8")
  await write(stopped)
  await write(served)
  await dropMarker(stopped)
  const use = async () => keysOf(state(served))
  expect(await count(stopped, "WorkspaceKnowledgeUnit")).toBe(2)
  // The first run gives the key a marker with a time. It does not remove it.
  expect(await gc(use, t0)).toEqual({ removed: 0 })
  expect(await count(stopped, "WorkspaceKnowledgeUnit")).toBe(2)
  expect(await gc(use, new Date(t0.getTime() + graceMs - 1000))).toEqual({
    removed: 0,
  })
  expect(await count(stopped, "WorkspaceKnowledgeUnit")).toBe(2)
  // Readers do not serve the key, because the marker lacks the counts.
  expect(await hasWorkspaceGraph({ ...org, revision: stopped })).toBe(false)

  expect(await gc(use, afterGrace)).toEqual({ removed: 1 })
  expect(await none(stopped)).toBe(true)
  expect(await hasGraph(served)).toBe(true)
})

it("never marks or removes the nodes of a write that runs now", async () => {
  const id = `ws_running_${suffix}`
  const running = revision(id, "9")
  await write(running)
  await dropMarker(running)
  // The Workspace wants this key, so the write that builds it is in progress.
  const use = async () =>
    keysOf({ kind: "building", desired: running, previous: null })
  expect(await gc(use, t0)).toEqual({ removed: 0 })
  expect(await gc(use, afterGrace)).toEqual({ removed: 0 })
  expect(await count(running, "WorkspaceProjection")).toBe(0)
  expect(await count(running, "WorkspaceKnowledgeUnit")).toBe(2)
})

it("reads the keys in use from the Workspaces of the org only, with one query", async () => {
  const otherOrgId = `${org.orgId}_other`
  const row = (
    orgId: string,
    id: string,
    activeSha: string | null,
    desiredSha: string,
  ) => {
    const url = `https://git.example.test/${id}/kb.git`
    return {
      id,
      orgId,
      slug: id,
      displayName: id,
      workspaceRepositoryUrl: url,
      desiredSha: desiredSha.repeat(40),
      desiredDefaultBranch: "main",
      activeRevision: activeSha
        ? {
            ...revision(id, activeSha),
            remote: { url, connectionId: null },
          }
        : null,
    }
  }
  const ready = row(org.orgId, `ws_wire_ready_${suffix}`, "a", "a")
  const building = row(org.orgId, `ws_wire_building_${suffix}`, "b", "c")
  const foreign = row(otherOrgId, `ws_wire_foreign_${suffix}`, "d", "d")
  const key = (r: ReturnType<typeof row>, sha: string) =>
    workspaceGraphRevisionKey({
      ...revision(r.id, sha),
      remote: { url: r.workspaceRepositoryUrl, connectionId: null },
    })
  try {
    for (const r of [ready, building, foreign])
      await withOrgDbContext(r.orgId, (db) => db.insert(workspaces).values(r))
    const inUse = await withOrgIdContext(
      { id: org.orgId, slug: org.orgSlug },
      () => loadWorkspaceGraphKeysInUse(org.orgId),
    )
    // A ready Workspace serves its key. A rebuilding one serves the old key and writes the new key.
    expect(inUse).toEqual(
      new Set([key(ready, "a"), key(building, "b"), key(building, "c")]),
    )
  } finally {
    for (const r of [ready, building, foreign])
      await withOrgDbContext(r.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.id, r.id)),
      )
  }
})
