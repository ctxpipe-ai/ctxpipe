import { beforeEach, describe, expect, it, vi } from "vitest"

const executeQueryMock = vi.hoisted(() => vi.fn())
const getGraphClientMock = vi.hoisted(() =>
  vi.fn(() => ({ executeQuery: executeQueryMock })),
)
const withGraphClientMock = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
)

vi.mock("../../platform/graph/client.js", () => ({
  getGraphClient: getGraphClientMock,
  withGraphClient: withGraphClientMock,
}))

import {
  graphTraversal,
  type HopEdge,
  pickRoundRobin,
} from "./graphTraversal.js"

describe("graphTraversal query dialect", () => {
  beforeEach(() => {
    executeQueryMock.mockReset()
    executeQueryMock.mockResolvedValue({ records: [] })
  })

  it("avoids ALL/ANY/NONE and datetime(), which not every provider supports", async () => {
    await graphTraversal("org_1", "acme", "obj_start")

    expect(executeQueryMock).toHaveBeenCalledTimes(1)
    const query = String(executeQueryMock.mock.calls[0]?.[0])
    expect(query).not.toMatch(/\bALL\s*\(/i)
    expect(query).not.toMatch(/\bANY\s*\(/i)
    expect(query).not.toMatch(/\bNONE\s*\(/i)
    expect(query).not.toMatch(/\bdatetime\s*\(/i)
    expect(query).toContain("a.orgId = $orgId")
    expect(query).toContain("b.orgId = $orgId")
  })

  it("filters validity by today unless a day is given", async () => {
    await graphTraversal("org_1", "acme", "obj_start")
    await graphTraversal("org_1", "acme", "obj_start", {
      validAt: new Date("2026-09-21T15:00:00.000Z"),
    })

    const today = new Date().toISOString().slice(0, 10)
    expect(executeQueryMock.mock.calls[0]?.[1]).toMatchObject({
      validDay: today,
    })
    expect(executeQueryMock.mock.calls[1]?.[1]).toMatchObject({
      validDay: "2026-09-21",
    })
  })

  it("restricts the extension layer to reference, cause, ownership, provenance and change edges", async () => {
    await graphTraversal("org_1", "acme", "obj_start", {
      useExtensionLayer: true,
    })

    const query = String(executeQueryMock.mock.calls[0]?.[0])
    expect(query).toContain(
      "type(rel) IN ['REFERENCES','MENTIONS','INFLUENCES','SUPERSEDES','OWNS','DECLARED_IN','TARGETS','ADDED','MODIFIED','REMOVED','RENAMED']",
    )
    expect(query).not.toContain("'PART_OF'")
  })

  it("sends the search hits, so the query can keep them first at equal trust", async () => {
    await graphTraversal("org_1", "acme", "obj_start", {
      preferIds: ["obj_hit"],
    })

    expect(executeQueryMock.mock.calls[0]?.[1]).toMatchObject({
      preferIds: ["obj_hit"],
    })
  })

  it("gives the start node with the reached nodes, so each end of a kept claim is readable", async () => {
    const row = (values: Record<string, unknown>) => ({
      get: (key: string) => values[key] ?? null,
    })
    executeQueryMock.mockResolvedValueOnce({
      records: [
        row({
          toId: "pr_1",
          toKind: "PullRequest",
          toName: "acme/api#12",
          toStatus: "",
          toSummary: "Move billing events to SQS",
          predicate: "TARGETS",
          claimId: "clm_1",
          trust: 0.95,
          validFrom: "2026-09-01T00:00:00.000Z",
          startKind: "Repository",
          startName: "acme/api",
          startStatus: "",
          startSummary: "The API",
        }),
      ],
    })

    const result = await graphTraversal("org_1", "acme", "repo_api", {
      maxDepth: 1,
    })

    expect(result.nodes).toEqual([
      {
        id: "repo_api",
        kind: "Repository",
        name: "acme/api",
        status: null,
        summary: null,
      },
      {
        id: "pr_1",
        kind: "PullRequest",
        name: "acme/api#12",
        status: null,
        summary: "Move billing events to SQS",
      },
    ])
    expect(result.edgeClaimIds).toEqual(["clm_1"])
  })
})

describe("pickRoundRobin", () => {
  const e = (
    predicate: string,
    toId: string,
    trust: number,
    more: Partial<HopEdge> = {},
  ): HopEdge => ({
    to: { id: toId, kind: null, name: null, status: null, summary: null },
    predicate,
    claimId: `clm_${toId}`,
    trust,
    validFrom: null,
    preferred: false,
    ...more,
  })
  const ids = (edges: HopEdge[]) => edges.map((x) => x.to.id)

  it("gives every relation type a slot before any type gets a second", () => {
    const edges = [
      e("PART_OF", "file_1", 0.95),
      e("PART_OF", "file_2", 0.95),
      e("PART_OF", "file_3", 0.95),
      e("INFLUENCES", "adr", 0.9),
      e("OWNS", "team", 0.95),
    ]

    expect(ids(pickRoundRobin(edges, 4))).toEqual([
      "file_1",
      "team",
      "adr",
      "file_2",
    ])
  })

  it("takes the most trusted edges within a type", () => {
    const edges = [
      e("DEPENDS_ON", "weak", 0.6),
      e("DEPENDS_ON", "strong", 0.95),
      e("DEPENDS_ON", "middle", 0.8),
    ]

    expect(ids(pickRoundRobin(edges, 2))).toEqual(["strong", "middle"])
  })

  it("gives the four file change types one turn together, so pull request changes do not take four turns", () => {
    const edges = [
      e("ADDED", "file_added", 0.95),
      e("MODIFIED", "file_modified", 0.95),
      e("REMOVED", "file_removed", 0.95),
      e("RENAMED", "file_renamed", 0.95),
      e("REFERENCES", "issue", 0.95),
      e("DECLARED_IN", "adr_file", 0.95),
    ]

    const picked = ids(pickRoundRobin(edges, 3))

    expect(picked).toContain("issue")
    expect(picked).toContain("adr_file")
    expect(picked.filter((id) => id.startsWith("file_"))).toHaveLength(1)
  })

  it("at equal trust, keeps search hits first, then the newest valid_from, then open-ended edges", () => {
    const edges = [
      e("TARGETS", "pr_open", 0.95, { claimId: "clm_a" }),
      e("TARGETS", "pr_old", 0.95, {
        claimId: "clm_b",
        validFrom: "2025-01-01T00:00:00.000Z",
      }),
      e("TARGETS", "pr_new", 0.95, {
        claimId: "clm_c",
        validFrom: "2026-09-01T00:00:00.000Z",
      }),
      e("TARGETS", "pr_hit", 0.95, {
        claimId: "clm_d",
        validFrom: "2024-01-01T00:00:00.000Z",
        preferred: true,
      }),
      e("TARGETS", "pr_trusted", 0.99, { claimId: "clm_e" }),
    ]

    expect(ids(pickRoundRobin(edges, 5))).toEqual([
      "pr_trusted",
      "pr_hit",
      "pr_new",
      "pr_old",
      "pr_open",
    ])
  })

  it("breaks the last tie by claim id in the order Cypher sorts text, whatever order the edges come in", () => {
    const edges = [
      e("PART_OF", "file_lower", 0.95, { claimId: "claim_a" }),
      e("PART_OF", "file_upper", 0.95, { claimId: "claim_B" }),
      e("PART_OF", "file_digit", 0.95, { claimId: "claim_2" }),
    ]

    const expected = ["file_digit", "file_upper", "file_lower"]
    expect(ids(pickRoundRobin(edges, 3))).toEqual(expected)
    expect(ids(pickRoundRobin([...edges].reverse(), 3))).toEqual(expected)
  })
})
