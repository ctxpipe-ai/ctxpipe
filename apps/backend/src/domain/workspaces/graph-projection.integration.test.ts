import { createHash } from "node:crypto"

import { FalkorDB } from "falkordb"
import { afterAll, beforeAll, expect, it } from "vitest"

import {
  closeGraphDb,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import { ensureWorkspaceGraphIndexes } from "../../platform/graph/indexes.js"
import {
  readWorkspaceGraph,
  WorkspaceGraphMissingError,
  workspaceGraphRevisionKey,
  writeWorkspaceRevisionGraph,
} from "./graph-projection.js"
import type { HydrateUnit } from "./hydrate.js"
import { type WorkspaceRevision, workspaceRevisionSchema } from "./revision.js"

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const org = { orgId: `org_test_graph_projection_${suffix}`, orgSlug: "acme" }
let falkor: FalkorDB

beforeAll(async () => {
  if (!process.env.GRAPH_DB_URI)
    throw new Error("GRAPH_DB_URI is required for the FalkorDB proof")
  falkor = await FalkorDB.connect({ url: process.env.GRAPH_DB_URI })
})

afterAll(async () => {
  if (!falkor) return
  if ((await falkor.list()).includes(org.orgId))
    await falkor.selectGraph(org.orgId).delete()
  await falkor.close()
  await closeGraphDb()
})

function revision(sha: string): WorkspaceRevision {
  return {
    workspaceId: `ws_${suffix}`,
    generation: 1,
    remote: { url: "https://git.example.test/acme/kb.git", connectionId: null },
    defaultBranch: "main",
    sha: sha.repeat(40),
    access: "read",
  }
}

function unit(path: string, links: string[], claims: string[] = []) {
  return {
    path,
    servingId: `ku_${path.replace(/\W/g, "_")}`,
    kind: null,
    body: `# ${path}\n`,
    links,
    claims: claims.map((to) => ({
      to,
      predicate: "DEPENDS_ON",
      confidence: 0.8,
      validFrom: null,
      validTo: null,
      source: null,
    })),
    title: path,
    source: "authored",
    updatedAt: null,
  } satisfies HydrateUnit
}

// A hub with three inbound links and one outbound link. The link to
// missing.md has no target unit and must not count.
const units = [
  unit("hub.md", ["a.md"]),
  unit("a.md", ["hub.md", "missing.md"], ["b.md"]),
  unit("b.md", ["hub.md"]),
  unit("c.md", ["hub.md"]),
]

const write = (rev: WorkspaceRevision, list: readonly HydrateUnit[]) =>
  withGraphClient(org, () =>
    writeWorkspaceRevisionGraph(getGraphClient(), {
      revision: rev,
      units: list,
    }),
  )

async function nodeRows(rev: WorkspaceRevision) {
  const result = await falkor
    .selectGraph(org.orgId)
    .query<Record<string, unknown>>(
      `MATCH (n:WorkspaceKnowledgeUnit {projectionKey: $key})
      RETURN n.id AS id, n.path AS path, n.degree AS degree,
        n.inDegree AS inDegree, n.outDegree AS outDegree ORDER BY id`,
      { params: { key: workspaceGraphRevisionKey(rev) } },
    )
  return result.data ?? []
}

async function edgeRows(rev: WorkspaceRevision) {
  const result = await falkor
    .selectGraph(org.orgId)
    .query<Record<string, unknown>>(
      `MATCH (s:WorkspaceKnowledgeUnit {projectionKey: $key})-[r:WorkspaceSignal]->(t:WorkspaceKnowledgeUnit)
      RETURN s.id AS s, t.id AS t, r.id AS id, r.predicate AS predicate ORDER BY id`,
      { params: { key: workspaceGraphRevisionKey(rev) } },
    )
  return result.data ?? []
}

function active(rev: WorkspaceRevision) {
  return {
    kind: "active" as const,
    revision: rev,
    stores: {
      embeddings: { kind: "ready" as const },
      graph: { kind: "ready" as const },
      index: { kind: "ready" as const },
    },
  }
}

it("sets path and degree counts on each node of a graph with a hub", async () => {
  const rev = revision("a")
  await write(rev, units)
  expect(await nodeRows(rev)).toEqual([
    { id: "ku_a_md", path: "a.md", degree: 3, inDegree: 1, outDegree: 2 },
    { id: "ku_b_md", path: "b.md", degree: 2, inDegree: 1, outDegree: 1 },
    { id: "ku_c_md", path: "c.md", degree: 1, inDegree: 0, outDegree: 1 },
    { id: "ku_hub_md", path: "hub.md", degree: 4, inDegree: 3, outDegree: 1 },
  ])
})

it("does not count a unit's own FROM_SOURCE edge in its degree, but counts it on the source", async () => {
  const rev = revision("f")
  const fromSource = (path: string) => {
    const base = unit(path, [], ["source.md"])
    return {
      ...base,
      claims: base.claims.map((claim) => ({
        ...claim,
        predicate: "FROM_SOURCE",
      })),
    }
  }
  await write(rev, [
    unit("source.md", []),
    fromSource("a.md"),
    { ...fromSource("b.md"), links: ["a.md"] },
  ])
  expect(await nodeRows(rev)).toEqual([
    { id: "ku_a_md", path: "a.md", degree: 1, inDegree: 1, outDegree: 1 },
    { id: "ku_b_md", path: "b.md", degree: 1, inDegree: 0, outDegree: 2 },
    {
      id: "ku_source_md",
      path: "source.md",
      degree: 2,
      inDegree: 2,
      outDegree: 0,
    },
  ])
})

it("writes the same graph when the units arrive in the opposite order", async () => {
  const forward = revision("b")
  const reverse = revision("c")
  await write(forward, units)
  await write(reverse, units.toReversed())
  expect(await nodeRows(reverse)).toEqual(await nodeRows(forward))
  expect(await edgeRows(reverse)).toEqual(await edgeRows(forward))
  expect(await edgeRows(forward)).toHaveLength(5)
})

it("writes a revision again with the same result", async () => {
  const rev = revision("d")
  await write(rev, units)
  const first = { nodes: await nodeRows(rev), edges: await edgeRows(rev) }
  await write(rev, units.toReversed())
  expect({ nodes: await nodeRows(rev), edges: await edgeRows(rev) }).toEqual(
    first,
  )
})

it("does not read a graph of an earlier projection version, so the revision projects again", async () => {
  const rev = revision("e")
  // Version 1 hashed the parsed revision alone. Write a complete marker under that key.
  const legacyKey = createHash("sha256")
    .update(JSON.stringify(workspaceRevisionSchema.parse(rev)))
    .digest("hex")
  expect(workspaceGraphRevisionKey(rev)).not.toBe(legacyKey)
  await falkor
    .selectGraph(org.orgId)
    .query(
      "CREATE (:WorkspaceProjection {projectionKey: $key, nodeCount: 0, claimCount: 0, completedAt: '2026-01-01T00:00:00.000Z'})",
      { params: { key: legacyKey } },
    )
  await expect(
    readWorkspaceGraph({ ...org, projection: active(rev) }),
  ).rejects.toBeInstanceOf(WorkspaceGraphMissingError)

  await write(rev, units)
  const graph = await readWorkspaceGraph({ ...org, projection: active(rev) })
  expect(graph.nodes).toHaveLength(4)
  expect(graph.nodes.map((node) => node.path).sort()).toEqual(
    units.map((u) => u.path).sort(),
  )
})

it("creates the FalkorDB node index, and a second run does not fail", async () => {
  const graphName = `${org.orgId}_indexes`
  const graph = falkor.selectGraph(graphName)
  try {
    const ensure = () =>
      withGraphClient({ ...org, orgId: graphName }, () =>
        ensureWorkspaceGraphIndexes(getGraphClient(), "falkordb"),
      )
    await ensure()
    await ensure()
    const indexes = await graph.query<Record<string, unknown>>(
      "CALL db.indexes() YIELD label, properties RETURN label, properties",
    )
    expect(indexes.data).toEqual([
      { label: "WorkspaceKnowledgeUnit", properties: ["projectionKey", "id"] },
    ])
  } finally {
    if ((await falkor.list()).includes(graphName)) await graph.delete()
  }
})

it("writes the graph when the graph store refuses to create the index", async () => {
  const rev = revision("f")
  await withGraphClient(org, () => {
    const real = getGraphClient()
    // Memgraph refuses index DDL in a managed transaction with this error.
    const refusesIndexes = {
      ...real,
      executeQuery: (query: string, params?: Record<string, unknown>) =>
        query.startsWith("CREATE INDEX")
          ? Promise.reject(
              new Error(
                "Index manipulation not allowed in multicommand transactions.",
              ),
            )
          : real.executeQuery(query, params),
    }
    return writeWorkspaceRevisionGraph(refusesIndexes, {
      revision: rev,
      units,
    })
  })
  expect(await nodeRows(rev)).toHaveLength(4)
})

it("sends no index DDL to Memgraph, which refuses it in the managed transactions of the client", async () => {
  const statements: string[] = []
  await ensureWorkspaceGraphIndexes(
    {
      executeQuery: async (query) => {
        statements.push(query)
        return { records: [] }
      },
      close: async () => {},
    },
    "memgraph",
  )
  expect(statements).toEqual([])
})
