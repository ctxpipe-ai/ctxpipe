import { FalkorDB } from "falkordb"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest"
import {
  closeGraphDb,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import {
  collectInactiveWorkspaceGraphKeys,
  type WorkspaceGraphUse,
  workspaceGraphUse,
} from "./graph-gc.js"
import {
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
const graceMs = 24 * 60 * 60 * 1000
const t0 = new Date("2026-03-01T00:00:00.000Z")
const afterGrace = new Date(t0.getTime() + graceMs + 1000)
let falkor: FalkorDB

beforeAll(async () => {
  if (!process.env.GRAPH_DB_URI)
    throw new Error("GRAPH_DB_URI is required for the FalkorDB proof")
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

function state(
  rev: WorkspaceRevision,
  graph: "ready" | "pending" = "ready",
): ProjectionState {
  return {
    kind: "active",
    revision: rev,
    stores: {
      embeddings: { kind: "ready" },
      graph: { kind: graph },
      index: { kind: "ready" },
    },
  }
}

const gc = (use: () => Promise<readonly WorkspaceGraphUse[]>, now: Date) =>
  collectInactiveWorkspaceGraphKeys({ ...org, loadUse: use, now })

it("removes an old key after the grace period, keeps the served key, and removes nothing on a second run", async () => {
  const id = `ws_old_${suffix}`
  const oldRev = revision(id, "a")
  const served = revision(id, "b")
  await write(oldRev)
  await write(served)
  const use = async () => [workspaceGraphUse(id, state(served))]

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

it("keeps a key that a Workspace captured or serves, even when it is old", async () => {
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
  const use = async () => [workspaceGraphUse(id, building)]
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
  const use = async () => [workspaceGraphUse(id, state(served))]
  await gc(use, t0) // marks the first key
  served = first
  await gc(use, new Date(t0.getTime() + 1000)) // the first key is in use: no mark
  served = second
  // The mark restarts here, so a run just after the first mark's grace keeps the key.
  await gc(use, new Date(t0.getTime() + 2000))
  expect(await gc(use, afterGrace)).toEqual({ removed: 0 })
  expect(await hasGraph(first)).toBe(true)
})

it("keeps old keys while the active graph of the Workspace is not ready", async () => {
  const id = `ws_pending_${suffix}`
  const oldRev = revision(id, "1")
  const next = revision(id, "2")
  await write(oldRev)
  const use = async () => [workspaceGraphUse(id, state(next, "pending"))]
  await gc(use, t0)
  expect(await gc(use, afterGrace)).toEqual({ removed: 0 })
  expect(await hasGraph(oldRev)).toBe(true)
  // The graph is ready now: the old key is marked, then removed.
  await write(next)
  const ready = async () => [workspaceGraphUse(id, state(next))]
  await gc(ready, afterGrace)
  expect(
    await gc(ready, new Date(afterGrace.getTime() + graceMs + 1000)),
  ).toEqual({ removed: 1 })
  expect(await none(oldRev)).toBe(true)
  expect(await hasGraph(next)).toBe(true)
})

it("keeps the key that a rebuild writes while the job runs", async () => {
  const id = `ws_rebuild_${suffix}`
  const rebuilt = revision(id, "3")
  // The marker of the rebuilt key is lost. The rebuild writes the graph
  // again while the runs execute.
  const use = async () => [workspaceGraphUse(id, state(rebuilt))]
  await Promise.all([gc(use, t0), write(rebuilt)])
  await Promise.all([gc(use, afterGrace), write(rebuilt)])
  expect(await hasGraph(rebuilt)).toBe(true)
})

it("keeps a key that a Workspace adopts between the mark and the removal", async () => {
  const id = `ws_adopt_${suffix}`
  const served = revision(id, "4")
  const adopted = revision(id, "5")
  await write(served)
  await write(adopted)
  await gc(async () => [workspaceGraphUse(id, state(served))], t0)
  let reads = 0
  const adopting = async () => {
    reads += 1
    return [workspaceGraphUse(id, state(reads === 1 ? served : adopted))]
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
  const use = async () => [] as WorkspaceGraphUse[]
  await gc(use, t0)
  expect(await gc(use, afterGrace)).toEqual({ removed: 20 })
  // The next run finishes the work, and a later run removes nothing.
  expect(await gc(use, afterGrace)).toEqual({ removed: 2 })
  expect(await gc(use, afterGrace)).toEqual({ removed: 0 })
  for (const rev of gone) expect(await none(rev)).toBe(true)
})
