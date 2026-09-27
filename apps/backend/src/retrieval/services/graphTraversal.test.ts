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

import { graphTraversal } from "./graphTraversal.js"

describe("graphTraversal query dialect", () => {
  beforeEach(() => {
    executeQueryMock.mockReset()
    executeQueryMock.mockResolvedValue({ records: [] })
  })

  it("uses openCypher size() list predicates instead of ALL/ANY/NONE", async () => {
    await graphTraversal("org_1", "acme", "obj_start")

    expect(executeQueryMock).toHaveBeenCalledTimes(1)
    const query = String(executeQueryMock.mock.calls[0]?.[0])
    expect(query).not.toMatch(/\bALL\s*\(/i)
    expect(query).not.toMatch(/\bANY\s*\(/i)
    expect(query).not.toMatch(/\bNONE\s*\(/i)
    expect(query).toContain(
      "size([node IN nodes(path) WHERE node.orgId = $orgId]) = size(nodes(path))",
    )
  })

  it("rewrites validAt and extension-layer filters with size()", async () => {
    await graphTraversal("org_1", "acme", "obj_start", {
      validAt: new Date("2026-09-21T00:00:00.000Z"),
      useExtensionLayer: true,
    })

    const query = String(executeQueryMock.mock.calls[0]?.[0])
    expect(query).not.toMatch(/\bALL\s*\(/i)
    expect(query).toContain("size([rel IN relationships(path) WHERE")
    expect(query).toContain("]) = size(relationships(path))")
    expect(query).toContain("type(rel) IN [")
    expect(query).toContain(
      "'REFERENCES','MENTIONS','INFLUENCES','SUPERSEDES','OWNS'",
    )
  })
})
