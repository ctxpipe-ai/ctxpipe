import { beforeEach, describe, expect, it, vi } from "vitest"

const executeQueryMock = vi.hoisted(() => vi.fn())
const getConfigMock = vi.hoisted(() => vi.fn())
const warnMock = vi.hoisted(() => vi.fn())

vi.mock("./client.js", () => ({
  getConfig: getConfigMock,
  getGraphClient: () => ({ executeQuery: executeQueryMock }),
}))

vi.mock("../../observability/logger.js", () => ({
  log: { warn: warnMock },
}))

import { ensureNodeIdIndexes } from "./indexes.js"

let org = 0
const nextOrg = () => `org_${++org}`

describe("ensureNodeIdIndexes", () => {
  beforeEach(() => {
    executeQueryMock.mockReset()
    executeQueryMock.mockResolvedValue({ records: [] })
    warnMock.mockReset()
    getConfigMock.mockReturnValue({ provider: "falkordb" })
  })

  it("creates one id index per kind, once per org", async () => {
    const orgId = nextOrg()
    await ensureNodeIdIndexes(orgId, ["Service", "File", "Service"])
    await ensureNodeIdIndexes(orgId, ["File"])

    expect(executeQueryMock.mock.calls.map((c) => c[0])).toEqual([
      "CREATE INDEX FOR (n:Service) ON (n.id)",
      "CREATE INDEX FOR (n:File) ON (n.id)",
    ])
  })

  it("uses each provider's syntax and leaves Neptune to index itself", async () => {
    const statements: Record<string, unknown> = {}
    for (const provider of [
      "neo4j-community",
      "neo4j-enterprise",
      "memgraph",
      "neptune",
    ]) {
      getConfigMock.mockReturnValue({ provider })
      executeQueryMock.mockClear()
      await ensureNodeIdIndexes(nextOrg(), ["File"])
      statements[provider] = executeQueryMock.mock.calls[0]?.[0]
    }

    expect(statements).toEqual({
      "neo4j-community": "CREATE INDEX IF NOT EXISTS FOR (n:File) ON (n.id)",
      "neo4j-enterprise": "CREATE INDEX IF NOT EXISTS FOR (n:File) ON (n.id)",
      memgraph: "CREATE INDEX ON :File(id)",
      neptune: undefined,
    })
  })

  it("treats an existing index as done and logs other failures without throwing", async () => {
    executeQueryMock
      .mockRejectedValueOnce(new Error("Attribute 'id' is already indexed"))
      .mockRejectedValueOnce(new Error("Permission denied"))

    await expect(
      ensureNodeIdIndexes(nextOrg(), ["Service", "File"]),
    ).resolves.toBeUndefined()

    expect(warnMock).toHaveBeenCalledTimes(1)
    expect(warnMock.mock.calls[0]?.[0]).toMatchObject({
      kind: "File",
      error: "Permission denied",
    })
  })

  it("skips kinds that are not safe Cypher labels", async () => {
    await ensureNodeIdIndexes(nextOrg(), ["File) DETACH DELETE (n"])

    expect(executeQueryMock).not.toHaveBeenCalled()
  })
})
