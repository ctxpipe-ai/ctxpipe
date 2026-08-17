import { beforeEach, describe, expect, it, vi } from "vitest"

const requireCurrentOrgIdMock = vi.hoisted(() => vi.fn(() => "org_1"))
const requireCurrentOrgSlugMock = vi.hoisted(() => vi.fn(() => "acme"))
const getSystemDbMock = vi.hoisted(() => vi.fn())
const getOrgDbMock = vi.hoisted(() => vi.fn())
const executeQueryMock = vi.hoisted(() => vi.fn())
const getGraphClientMock = vi.hoisted(() =>
  vi.fn(() => ({ executeQuery: executeQueryMock })),
)
const withGraphClientMock = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
)
const flushWorkflowLogMock = vi.hoisted(() => vi.fn())
const getLoggerMock = vi.hoisted(() => {
  const logger = {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  return vi.fn(() => logger)
})

vi.mock("../../auth/context.js", () => ({
  requireCurrentOrgId: requireCurrentOrgIdMock,
  requireCurrentOrgSlug: requireCurrentOrgSlugMock,
}))

vi.mock("../../db/client.js", () => ({
  getSystemDb: getSystemDbMock,
  getOrgDb: getOrgDbMock,
}))

vi.mock("../../platform/graph/client.js", () => ({
  getGraphClient: getGraphClientMock,
  withGraphClient: withGraphClientMock,
}))

vi.mock("../../observability/logger.js", () => ({
  getLogger: getLoggerMock,
  flushWorkflowLog: flushWorkflowLogMock,
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import {
  deleteObjectsFromGraph,
  groupClaimsForBatchProjection,
  PROJECT_CLAIM_BATCH_SIZE,
  projectClaimsFromState,
  retractClaimsFromGraph,
  type PreparedProjectionRow,
} from "./graphProjection.js"
import type { ClaimForProjection } from "../schema/claimForProjection.js"

function makeClaim(
  overrides: Partial<ClaimForProjection> & Pick<ClaimForProjection, "id">,
): ClaimForProjection {
  return {
    subjectId: "svc_a",
    objectId: "api_b",
    subjectKind: "Service",
    objectKind: "API",
    predicate: "EXPOSES_API",
    status: "active",
    aggregatedConfidence: 0.9,
    sourceCount: 1,
    lastObservedAt: "2026-01-01T00:00:00.000Z",
    validFrom: null,
    validTo: null,
    ...overrides,
  }
}

describe("groupClaimsForBatchProjection", () => {
  it("groups by subjectKind, objectKind, and predicate", () => {
    const rows: PreparedProjectionRow[] = [
      {
        claim: makeClaim({ id: "c1", predicate: "EXPOSES_API" }),
        subjectProps: { id: "svc_a", kind: "Service" },
        objectProps: { id: "api_b", kind: "API" },
      },
      {
        claim: makeClaim({
          id: "c2",
          predicate: "DEPENDS_ON",
          objectId: "db_1",
          objectKind: "Database",
        }),
        subjectProps: { id: "svc_a", kind: "Service" },
        objectProps: { id: "db_1", kind: "Database" },
      },
      {
        claim: makeClaim({ id: "c3", predicate: "EXPOSES_API", objectId: "api_c" }),
        subjectProps: { id: "svc_a", kind: "Service" },
        objectProps: { id: "api_c", kind: "API" },
      },
    ]
    const groups = groupClaimsForBatchProjection(rows)
    expect(groups.size).toBe(2)
    expect(groups.get("Service\0API\0EXPOSES_API")).toHaveLength(2)
    expect(groups.get("Service\0Database\0DEPENDS_ON")).toHaveLength(1)
  })
})

describe("projectClaimsFromState", () => {
  beforeEach(() => {
    executeQueryMock.mockReset()
    executeQueryMock.mockResolvedValue({ records: [] })
    flushWorkflowLogMock.mockReset()
    getLoggerMock.mockClear()
    withGraphClientMock.mockClear()

    const where = vi.fn().mockResolvedValue([
      {
        id: "svc_a",
        kind: "Service",
        payload: { name: "svc", summary: "s" },
      },
      {
        id: "api_b",
        kind: "API",
        payload: { name: "api" },
      },
      {
        id: "api_c",
        kind: "API",
        payload: { name: "api2" },
      },
      {
        id: "db_1",
        kind: "Database",
        payload: { name: "db" },
      },
    ])
    getSystemDbMock.mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      }),
    })
  })

  it("issues far fewer graph queries than claims via UNWIND batches", async () => {
    const claims = Array.from({ length: 250 }, (_, i) =>
      makeClaim({
        id: `claim_${i}`,
        objectId: i % 2 === 0 ? "api_b" : "api_c",
      }),
    )

    const result = await projectClaimsFromState(claims)
    expect(result.projected).toBe(250)
    // One group (Service/API/EXPOSES_API), chunk size 100 → 3 UNWIND queries
    expect(executeQueryMock.mock.calls.length).toBe(
      Math.ceil(250 / PROJECT_CLAIM_BATCH_SIZE),
    )
    expect(executeQueryMock.mock.calls[0]?.[0]).toContain("UNWIND $rows AS row")
    expect(flushWorkflowLogMock).toHaveBeenCalled()
  })

  it("skips invalid predicates without querying them", async () => {
    await projectClaimsFromState([
      makeClaim({ id: "ok" }),
      makeClaim({ id: "bad", predicate: "NOT_A_REAL_EDGE" }),
    ])
    expect(executeQueryMock).toHaveBeenCalledTimes(1)
    const rows = executeQueryMock.mock.calls[0]?.[1]?.rows as unknown[]
    expect(rows).toHaveLength(1)
  })

  it("falls back to per-claim queries when a batch fails", async () => {
    executeQueryMock
      .mockRejectedValueOnce(new Error("batch boom"))
      .mockResolvedValue({ records: [] })

    const claims = [
      makeClaim({ id: "c1" }),
      makeClaim({ id: "c2", objectId: "api_c" }),
    ]
    const result = await projectClaimsFromState(claims)
    expect(result.projected).toBe(2)
    // 1 failed batch + 2 single-claim fallbacks
    expect(executeQueryMock).toHaveBeenCalledTimes(3)
    expect(executeQueryMock.mock.calls[1]?.[0]).not.toContain("UNWIND")
  })

  it("groups mixed predicates into separate batch queries", async () => {
    await projectClaimsFromState([
      makeClaim({ id: "c1", predicate: "EXPOSES_API" }),
      makeClaim({
        id: "c2",
        predicate: "DEPENDS_ON",
        objectId: "db_1",
        objectKind: "Database",
      }),
    ])
    expect(executeQueryMock).toHaveBeenCalledTimes(2)
    expect(executeQueryMock.mock.calls[0]?.[0]).toContain(":EXPOSES_API")
    expect(executeQueryMock.mock.calls[1]?.[0]).toContain(":DEPENDS_ON")
  })
})

describe("retractClaimsFromGraph / deleteObjectsFromGraph", () => {
  beforeEach(() => {
    executeQueryMock.mockReset()
    executeQueryMock.mockResolvedValue({ records: [] })
  })

  it("retracts many claim edges with one UNWIND query", async () => {
    await retractClaimsFromGraph(["c1", "c2", "c1"])
    expect(executeQueryMock).toHaveBeenCalledTimes(1)
    expect(executeQueryMock.mock.calls[0]?.[0]).toContain("UNWIND $claimIds")
    expect(executeQueryMock.mock.calls[0]?.[1]).toEqual({
      claimIds: ["c1", "c2"],
      orgId: "org_1",
    })
  })

  it("deletes many object nodes with one UNWIND query", async () => {
    await deleteObjectsFromGraph(["o1", "o2"])
    expect(executeQueryMock).toHaveBeenCalledTimes(1)
    expect(executeQueryMock.mock.calls[0]?.[0]).toContain("UNWIND $ids")
    expect(executeQueryMock.mock.calls[0]?.[1]).toEqual({
      ids: ["o1", "o2"],
      orgId: "org_1",
    })
  })
})
