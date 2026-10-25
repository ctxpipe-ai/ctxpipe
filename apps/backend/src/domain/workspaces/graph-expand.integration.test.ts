import { FalkorDB } from "falkordb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  closeGraphDb,
  getGraphClient,
  withGraphClient,
} from "../../platform/graph/client.js"
import { expandHop, expandWorkspaceGraph } from "./graph-expand.js"
import {
  workspaceGraphRevisionKey,
  writeWorkspaceRevisionGraph,
} from "./graph-projection.js"
import { WorkspaceGraphBuildingError } from "./graph-rebuild.js"
import type { HydrateUnit } from "./hydrate.js"
import type { PublishedProjection, WorkspaceRevision } from "./revision.js"

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const org = { orgId: `org_test_graph_expand_${suffix}`, orgSlug: "acme" }
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

let revisions = 0
function revision(): WorkspaceRevision {
  revisions += 1
  return {
    workspaceId: `ws_${suffix}`,
    generation: revisions,
    remote: { url: "https://git.example.test/acme/kb.git", connectionId: null },
    defaultBranch: "main",
    sha: String(revisions % 10).repeat(40),
    access: "read",
  }
}

type Claim = {
  to: string
  predicate?: string
  confidence?: number
  validFrom?: string | null
  validTo?: string | null
}

const id = (path: string) => `ku_${path.replace(/\W/g, "_")}`

function unit(path: string, claims: Claim[] = []): HydrateUnit {
  return {
    path,
    servingId: id(path),
    kind: null,
    body: `# ${path}\n`,
    links: [],
    claims: claims.map((claim) => ({
      to: claim.to,
      predicate: claim.predicate ?? "DEPENDS_ON",
      confidence: claim.confidence ?? 0.8,
      validFrom: claim.validFrom ?? null,
      validTo: claim.validTo ?? null,
      source: null,
    })),
    title: path,
    source: "authored",
    updatedAt: null,
  } satisfies HydrateUnit
}

function active(
  rev: WorkspaceRevision,
): Extract<PublishedProjection, { kind: "active" }> {
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

async function publish(units: readonly HydrateUnit[]) {
  const rev = revision()
  await withGraphClient(org, () =>
    writeWorkspaceRevisionGraph(getGraphClient(), { revision: rev, units }),
  )
  return active(rev)
}

const expand = (
  projection: PublishedProjection,
  params: Omit<
    Parameters<typeof expandWorkspaceGraph>[0],
    "orgId" | "orgSlug" | "projection"
  >,
) => expandWorkspaceGraph({ ...org, projection, ...params })

const edgeIds = (result: { edges: Array<{ id: string }> }) =>
  result.edges.map((edge) => edge.id)
const nodeIds = (result: { nodes: Array<{ id: string }> }) =>
  result.nodes.map((node) => node.id)

describe("expandWorkspaceGraph on FalkorDB", () => {
  it(
    "keeps the top 50 edges by confidence of a 2,000-edge hub and lists the hub",
    { timeout: 60_000 },
    async () => {
      const leaves = Array.from({ length: 2000 }, (_, i) => `leaf-${i}.md`)
      const projection = await publish([
        unit(
          "hub.md",
          leaves.map((to, i) => ({ to, confidence: (i + 1) / 2000 })),
        ),
        ...leaves.map((path) => unit(path)),
      ])
      const hop = await withGraphClient(org, () =>
        expandHop(getGraphClient(), {
          projectionKey: workspaceGraphRevisionKey(projection.revision),
          frontier: [id("hub.md")],
          direction: "out",
          predicates: undefined,
          minConfidence: 0,
          maxFanOut: 50,
          remainingEdges: 25_000,
          seenEdges: [],
          window: {
            from: "2026-01-01T00:00:00.000Z",
            to: "2026-01-01T00:00:00.000Z",
          },
        }),
      )
      expect(hop.edges).toHaveLength(51)
      expect(hop.edges.filter((edge) => edge.probe)).toHaveLength(1)
      const limited = await withGraphClient(org, () =>
        expandHop(getGraphClient(), {
          projectionKey: workspaceGraphRevisionKey(projection.revision),
          frontier: [id("hub.md")],
          direction: "out",
          predicates: undefined,
          minConfidence: 0,
          maxFanOut: 50,
          remainingEdges: 10,
          seenEdges: [],
          window: {
            from: "2026-01-01T00:00:00.000Z",
            to: "2026-01-01T00:00:00.000Z",
          },
        }),
      )
      expect(limited.edges).toHaveLength(11)
      expect(limited.cappedHubs).toEqual([id("hub.md")])
      const timed = await expand(projection, {
        seeds: [id("hub.md")],
        maxFanOut: 1_000,
        caps: { hopTimeoutMs: 2 },
      })
      expect(timed).toMatchObject({
        partial: true,
        partialReason: "hop_timeout",
      })
      expect(nodeIds(timed)).toEqual([id("hub.md")])

      const result = await expand(projection, {
        seeds: [id("hub.md")],
        maxDepth: 1,
        maxFanOut: 50,
      })
      const top = leaves.slice(-50).map(id).sort()
      expect(result.partial).toBe(false)
      expect(result.cappedHubs).toEqual([id("hub.md")])
      expect(result.edges).toHaveLength(50)
      expect(result.edges.map((edge) => edge.targetId).sort()).toEqual(top)
      expect(Math.min(...result.edges.map((e) => e.confidence))).toBe(
        1951 / 2000,
      )
      expect(nodeIds(result)).toEqual([id("hub.md"), ...top].sort())
      const hub = result.nodes.find((node) => node.id === id("hub.md"))
      expect(hub).toMatchObject({ depth: 0, path: "hub.md", outDegree: 2000 })
    },
  )

  it("takes the fan-out in turns by predicate, so many strong edges of one predicate do not hide a weaker owner", async () => {
    const changes = Array.from({ length: 60 }, (_, i) => `change-${i}.md`)
    const projection = await publish([
      unit("service.md", [
        ...changes.map((to) => ({
          to,
          predicate: "CHANGED",
          confidence: 0.95,
        })),
        { to: "team.md", predicate: "OWNS", confidence: 0.5 },
        { to: "lib-a.md", predicate: "USES_LIBRARY", confidence: 0.6 },
        { to: "lib-b.md", predicate: "USES_LIBRARY", confidence: 0.7 },
      ]),
      ...changes.map((path) => unit(path)),
      unit("team.md"),
      unit("lib-a.md"),
      unit("lib-b.md"),
    ])
    const result = await expand(projection, {
      seeds: [id("service.md")],
      maxDepth: 1,
      maxFanOut: 4,
    })
    expect(result.cappedHubs).toEqual([id("service.md")])
    // Round 1: the strongest edge of each predicate. Round 2 starts with the
    // strongest second edge (CHANGED, 0.95) and the cap stops it there.
    expect(result.edges.map((edge) => edge.predicate).sort()).toEqual([
      "CHANGED",
      "CHANGED",
      "OWNS",
      "USES_LIBRARY",
    ])
    expect(result.edges.map((edge) => edge.targetId)).toEqual(
      expect.arrayContaining([id("team.md"), id("lib-b.md")]),
    )
    const wide = await expand(projection, {
      seeds: [id("service.md")],
      maxDepth: 1,
      maxFanOut: 1_000,
    })
    expect(wide.edges).toHaveLength(63)
    expect(wide.cappedHubs).toEqual([])
  })

  it(
    "reads at most the fan-out of each predicate of a hub with 3,000 edges of one predicate",
    { timeout: 60_000 },
    async () => {
      const notes = Array.from({ length: 3000 }, (_, i) => `note-${i}.md`)
      const others = ["A", "B", "C", "D", "E", "F"].map((letter, i) => ({
        to: `other-${letter}.md`,
        predicate: `REL_${letter}`,
        confidence: 0.3 + i * 0.1,
      }))
      const projection = await publish([
        unit("hub.md", [
          ...notes.map((to, i) => ({
            to,
            predicate: "PART_OF",
            confidence: 0.2 + (i % 1000) / 2000,
          })),
          ...others,
        ]),
        ...notes.map((path) => unit(path)),
        ...others.map(({ to }) => unit(to)),
      ])
      const hop = (maxFanOut: number) =>
        withGraphClient(org, () =>
          expandHop(getGraphClient(), {
            projectionKey: workspaceGraphRevisionKey(projection.revision),
            frontier: [id("hub.md")],
            direction: "out",
            predicates: undefined,
            minConfidence: 0,
            maxFanOut,
            remainingEdges: 25_000,
            seenEdges: [],
            window: {
              from: "2026-01-01T00:00:00.000Z",
              to: "2026-01-01T00:00:00.000Z",
            },
          }),
        )
      // Round 1 holds the strongest edge of each of the 7 predicates. Rounds
      // 2 and 3 hold only PART_OF edges. The fan-out of 9 stops there, and
      // one more edge is the probe that marks the hub.
      const wide = await hop(9)
      expect(wide.cappedHubs).toEqual([id("hub.md")])
      expect(wide.edges).toHaveLength(10)
      const kept = wide.edges.filter((edge) => !edge.probe)
      expect(kept.map((edge) => edge.predicate).sort()).toEqual([
        "PART_OF",
        "PART_OF",
        "PART_OF",
        "REL_A",
        "REL_B",
        "REL_C",
        "REL_D",
        "REL_E",
        "REL_F",
      ])
      for (const edge of kept.filter((edge) => edge.predicate === "PART_OF"))
        expect(edge.confidence).toBeCloseTo(0.6995)
      // More predicates than the fan-out: the predicates with the strongest
      // edges win.
      const narrow = await hop(2)
      expect(
        narrow.edges
          .filter((edge) => !edge.probe)
          .map((edge) => edge.predicate)
          .sort(),
      ).toEqual(["REL_E", "REL_F"])
      expect(narrow.edges).toHaveLength(3)
    },
  )

  it("stops an in-flight query at its server deadline", async () => {
    await publish([unit("slow.md")])
    await withGraphClient(org, async () => {
      const client = getGraphClient()
      const query =
        "UNWIND range(1, 1000) AS a UNWIND range(1, 1000) AS b RETURN sum(a * b) AS total"
      await expect(
        client.executeQuery(query, {}, { deadline: performance.now() + 10 }),
      ).rejects.toMatchObject({
        name: "GraphQueryTimeoutError",
        cause: expect.objectContaining({
          message: expect.stringMatching(/timed out|timeout/i),
        }),
      })
      const result = await client.executeQuery("RETURN 1 AS ready")
      expect(result.records[0]?.get("ready")).toBe(1)
    })
  })

  it("walks no expired edge unless the time window includes it", async () => {
    const projection = await publish([
      unit("a.md", [
        { to: "old.md", validTo: "2020-01-01T00:00:00.000Z" },
        { to: "now.md", validFrom: "2019-01-01T00:00:00.000Z" },
        { to: "later.md", validFrom: "2999-01-01T00:00:00.000Z" },
      ]),
      unit("old.md"),
      unit("now.md"),
      unit("later.md"),
    ])
    const seeds = [id("a.md")]
    const now = await expand(projection, { seeds })
    expect(nodeIds(now)).toEqual([id("a.md"), id("now.md")])
    const past = await expand(projection, {
      seeds,
      validAt: "2019-06-01T00:00:00.000Z",
    })
    expect(nodeIds(past)).toEqual([id("a.md"), id("now.md"), id("old.md")])
    const between = await expand(projection, {
      seeds,
      validBetween: {
        from: "2018-01-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      },
    })
    expect(nodeIds(between)).toEqual([id("a.md"), id("now.md"), id("old.md")])
  })

  it("compares offset times and boundary instants in UTC and ignores non-time bounds", async () => {
    const projection = await publish([
      unit("a.md", [
        {
          to: "window.md",
          validFrom: "2026-01-01T01:00:00+01:00",
          validTo: "2026-01-01T02:00:00+01:00",
        },
        { to: "unbounded.md", validFrom: "Q3 2025", validTo: "not-a-time" },
      ]),
      unit("window.md"),
      unit("unbounded.md"),
    ])
    const seeds = [id("a.md")]
    const start = await expand(projection, {
      seeds,
      validAt: "2025-12-31T19:00:00-05:00",
    })
    expect(start.edges).toHaveLength(2)
    expect(start.edges[0]).toMatchObject({
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2026-01-01T01:00:00.000Z",
    })
    expect(start.edges[1]).toMatchObject({ validFrom: null, validTo: null })
    const end = await expand(projection, {
      seeds,
      validAt: "2026-01-01T01:00:00Z",
    })
    expect(end.edges.map((edge) => edge.targetId)).toEqual([id("unbounded.md")])
    const between = await expand(projection, {
      seeds,
      validBetween: {
        from: "2025-12-31T19:00:00-05:00",
        to: "2026-01-01T00:30:00Z",
      },
    })
    expect(between.edges).toHaveLength(2)
    await expect(
      expand(projection, {
        seeds,
        validBetween: {
          from: "2025-12-31T23:00:00-05:00",
          to: "2026-01-01T00:00:00Z",
        },
      }),
    ).rejects.toThrow("Validity window ends before it starts.")
  })

  it("filters by direction, predicate, and minimum confidence", async () => {
    const projection = await publish([
      unit("a.md", [
        { to: "b.md", predicate: "DEPENDS_ON", confidence: 0.9 },
        { to: "c.md", predicate: "OWNED_BY", confidence: 0.9 },
        { to: "d.md", predicate: "DEPENDS_ON", confidence: 0.2 },
      ]),
      unit("b.md"),
      unit("c.md"),
      unit("d.md"),
      unit("e.md", [{ to: "a.md", predicate: "DEPENDS_ON", confidence: 0.9 }]),
    ])
    const seeds = [id("a.md")]
    expect(nodeIds(await expand(projection, { seeds }))).toEqual(
      ["a.md", "b.md", "c.md", "d.md", "e.md"].map(id),
    )
    expect(
      nodeIds(await expand(projection, { seeds, direction: "out" })),
    ).toEqual(["a.md", "b.md", "c.md", "d.md"].map(id))
    const incoming = await expand(projection, { seeds, direction: "in" })
    expect(nodeIds(incoming)).toEqual(["a.md", "e.md"].map(id))
    expect(incoming.edges[0]).toMatchObject({
      sourceId: id("e.md"),
      targetId: id("a.md"),
    })
    expect(
      nodeIds(
        await expand(projection, {
          seeds,
          predicates: ["DEPENDS_ON"],
          minConfidence: 0.5,
        }),
      ),
    ).toEqual(["a.md", "b.md", "e.md"].map(id))
  })

  it("walks a FROM_SOURCE edge only when the predicates name it", async () => {
    const projection = await publish([
      unit("a.md", [
        { to: "b.md", predicate: "DEPENDS_ON" },
        { to: "source.md", predicate: "FROM_SOURCE" },
      ]),
      unit("b.md"),
      unit("source.md"),
    ])
    const seeds = [id("a.md")]
    expect(nodeIds(await expand(projection, { seeds }))).toEqual(
      ["a.md", "b.md"].map(id),
    )
    expect(
      nodeIds(
        await expand(projection, {
          seeds,
          predicates: ["FROM_SOURCE", "DEPENDS_ON"],
        }),
      ),
    ).toEqual(["a.md", "b.md", "source.md"].map(id))
  })

  it("stops at maxDepth and gives each node its hop", async () => {
    const projection = await publish([
      unit("a.md", [{ to: "b.md" }]),
      unit("b.md", [{ to: "c.md" }]),
      unit("c.md", [{ to: "d.md" }]),
      unit("d.md"),
    ])
    const seeds = [id("a.md")]
    const lookup = await expand(projection, { seeds, maxDepth: 0 })
    expect(lookup.nodes).toEqual([
      expect.objectContaining({
        id: id("a.md"),
        depth: 0,
        kind: "KnowledgeUnit",
      }),
    ])
    expect(lookup.edges).toEqual([])
    const two = await expand(projection, { seeds, maxDepth: 2 })
    expect(two.nodes.map((node) => [node.id, node.depth])).toEqual([
      [id("a.md"), 0],
      [id("b.md"), 1],
      [id("c.md"), 2],
    ])
    expect(edgeIds(two)).toEqual([`${id("a.md")}:0`, `${id("b.md")}:0`])
    const unknown = await expand(projection, { seeds: ["ku_missing"] })
    expect(unknown).toMatchObject({ nodes: [], edges: [], partial: false })
  })

  it("marks the result partial at each cap", async () => {
    const projection = await publish([
      unit("a.md", [
        { to: "b.md", confidence: 0.9 },
        { to: "c.md", confidence: 0.8 },
        { to: "d.md", confidence: 0.7 },
      ]),
      unit("b.md", [{ to: "c.md" }]),
      unit("c.md"),
      unit("d.md"),
    ])
    const seeds = [id("a.md")]
    const nodes = await expand(projection, {
      seeds,
      maxDepth: 2,
      caps: { maxNodes: 3 },
    })
    expect(nodes).toMatchObject({ partial: true, partialReason: "max_nodes" })
    expect(nodeIds(nodes)).toEqual(["a.md", "b.md", "c.md"].map(id))
    const edges = await expand(projection, {
      seeds,
      maxDepth: 2,
      caps: { maxEdges: 2 },
    })
    expect(edges).toMatchObject({ partial: true, partialReason: "max_edges" })
    expect(edgeIds(edges)).toEqual([`${id("a.md")}:0`, `${id("a.md")}:1`])
    const total = await expand(projection, {
      seeds,
      caps: { totalTimeoutMs: 0 },
    })
    expect(total).toMatchObject({
      partial: true,
      partialReason: "total_timeout",
    })
    expect(nodeIds(total)).toEqual([])
    const complete = await expand(projection, { seeds, maxDepth: 2 })
    expect(complete).toMatchObject({ partial: false, partialReason: null })
  })

  it("limits seed nodes and rejects limits above the hard caps", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `seed-${i}.md`)
    const projection = await publish(paths.map((path) => unit(path)))
    const seeds = paths.map(id)
    const result = await expand(projection, {
      seeds,
      maxDepth: 0,
      caps: { maxNodes: 1 },
    })
    expect(nodeIds(result)).toEqual([id("seed-0.md")])
    expect(result).toMatchObject({ partial: true, partialReason: "max_nodes" })
    // A test can give the walk up to 60 s, so the timeouts stop there.
    for (const caps of [
      { maxNodes: 5_001 },
      { maxEdges: 25_001 },
      { hopTimeoutMs: 60_001 },
      { totalTimeoutMs: 60_001 },
    ]) {
      await expect(expand(projection, { seeds, caps })).rejects.toThrow()
    }
  })

  it("counts a shared edge once before the hop row limit", async () => {
    const projection = await publish([
      unit("a.md", [{ to: "b.md", confidence: 0.9 }]),
      unit("b.md", [
        { to: "c.md", confidence: 0.8 },
        { to: "d.md", confidence: 0.7 },
        { to: "e.md", confidence: 0.6 },
      ]),
      unit("c.md"),
      unit("d.md"),
      unit("e.md"),
    ])
    const result = await expand(projection, {
      seeds: [id("a.md"), id("b.md")],
      caps: { maxEdges: 2 },
    })
    expect(result.edges).toHaveLength(2)
    expect(result).toMatchObject({ partial: true, partialReason: "max_edges" })
  })

  it("gives the same result for two write orders", async () => {
    const units = [
      unit("a.md", [
        { to: "b.md", confidence: 0.5 },
        { to: "c.md", confidence: 0.5 },
        { to: "d.md", confidence: 0.5 },
      ]),
      unit("b.md", [{ to: "c.md", confidence: 0.5 }]),
      unit("c.md", [{ to: "a.md", confidence: 0.5 }]),
      unit("d.md"),
    ]
    const forward = await publish(units)
    const backward = await publish([...units].reverse())
    const params = { seeds: [id("a.md")], maxDepth: 2, maxFanOut: 2 }
    const first = await expand(forward, params)
    expect(await expand(backward, params)).toEqual(first)
    // a.md and c.md each have three matching edges at their hop.
    expect(first.cappedHubs).toEqual([id("a.md"), id("c.md")])
    expect(edgeIds(first)).toEqual([
      `${id("a.md")}:0`,
      `${id("a.md")}:1`,
      `${id("b.md")}:0`,
    ])
  })

  it("gives the building error while the graph phase is pending", async () => {
    const rev = revision()
    await expect(
      expand(
        {
          kind: "active",
          revision: rev,
          stores: {
            embeddings: { kind: "ready" },
            graph: { kind: "pending" },
            index: { kind: "ready" },
          },
        },
        { seeds: [id("a.md")] },
      ),
    ).rejects.toBeInstanceOf(WorkspaceGraphBuildingError)
  })
})
