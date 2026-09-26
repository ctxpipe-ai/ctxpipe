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

  it("restricts the extension layer to reference, cause and ownership edges", async () => {
    await graphTraversal("org_1", "acme", "obj_start", {
      useExtensionLayer: true,
    })

    const query = String(executeQueryMock.mock.calls[0]?.[0])
    expect(query).toContain(
      "type(rel) IN ['REFERENCES','MENTIONS','INFLUENCES','SUPERSEDES','OWNS']",
    )
  })
})

describe("pickRoundRobin", () => {
  const e = (predicate: string, toId: string, trust: number): HopEdge => ({
    toId,
    predicate,
    claimId: `clm_${toId}`,
    trust,
  })

  it("gives every relation type a slot before any type gets a second", () => {
    const edges = [
      e("PART_OF", "file_1", 0.95),
      e("PART_OF", "file_2", 0.95),
      e("PART_OF", "file_3", 0.95),
      e("INFLUENCES", "adr", 0.9),
      e("OWNS", "team", 0.95),
    ]

    expect(pickRoundRobin(edges, 4).map((x) => x.toId)).toEqual([
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

    expect(pickRoundRobin(edges, 2).map((x) => x.toId)).toEqual([
      "strong",
      "middle",
    ])
  })
})
