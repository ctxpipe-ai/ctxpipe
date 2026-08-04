import { beforeEach, describe, expect, it, vi } from "vitest"

const getOrgDbMock = vi.hoisted(() => vi.fn())
const requireCurrentOrgIdMock = vi.hoisted(() => vi.fn(() => "org_1"))
const generateObjectIdMock = vi.hoisted(() => {
  let n = 0
  return vi.fn((prefix: string) => `${prefix}_${++n}`)
})

vi.mock("../../db/client.js", () => ({
  getOrgDb: getOrgDbMock,
}))

vi.mock("../../auth/context.js", () => ({
  requireCurrentOrgId: requireCurrentOrgIdMock,
}))

vi.mock("../../lib/id.js", () => ({
  generateObjectId: generateObjectIdMock,
}))

import {
  addEvidenceBulk,
  createClaimsWithEvidenceBulk,
} from "./claimWrite.js"

describe("createClaimsWithEvidenceBulk", () => {
  beforeEach(() => {
    getOrgDbMock.mockReset()
    generateObjectIdMock.mockClear()
  })

  it("validates then batch-inserts claims and evidence once per chunk", async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined)
    const insert = vi.fn().mockReturnValue({ values: insertValues })
    getOrgDbMock.mockReturnValue({ insert })

    await createClaimsWithEvidenceBulk([
      {
        claimId: "claim_a",
        claim: {
          subjectId: "svc_a",
          predicate: "EXPOSES_API",
          objectId: "api_b",
          subjectKind: "Service",
          objectKind: "API",
        },
        evidence: {
          sourceType: "git",
          sourceId: "path/a.ts",
          logicalSourceKey: "path/a.ts",
          extractionMethod: "deterministic",
          confidence: 0.9,
        },
      },
      {
        claimId: "claim_b",
        claim: {
          subjectId: "svc_a",
          predicate: "DEPENDS_ON",
          objectId: "db_c",
          subjectKind: "Service",
          objectKind: "Database",
        },
        evidence: {
          sourceType: "git",
          sourceId: "path/b.ts",
          logicalSourceKey: "path/b.ts",
          extractionMethod: "llm",
          confidence: 0.7,
        },
      },
    ])

    // one claims insert + one evidence insert
    expect(insertValues).toHaveBeenCalledTimes(2)
    expect(insertValues.mock.calls[0]?.[0]).toHaveLength(2)
    expect(insertValues.mock.calls[1]?.[0]).toHaveLength(2)
  })

  it("no-ops on empty input", async () => {
    await createClaimsWithEvidenceBulk([])
    expect(getOrgDbMock).not.toHaveBeenCalled()
  })
})

describe("addEvidenceBulk", () => {
  beforeEach(() => {
    getOrgDbMock.mockReset()
    generateObjectIdMock.mockClear()
  })

  it("inserts evidence then recomputes aggregates once per claim", async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined)
    const insert = vi.fn().mockReturnValue({ values: insertValues })
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
    const update = vi.fn().mockReturnValue({ set: updateSet })
    const selectWhere = vi.fn().mockResolvedValue([
      {
        claimId: "claim_1",
        sourceType: "git",
        extractionMethod: "deterministic",
        confidence: 0.9,
        observedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        claimId: "claim_1",
        sourceType: "git",
        extractionMethod: "llm",
        confidence: 0.7,
        observedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ])
    const selectFrom = vi.fn().mockReturnValue({ where: selectWhere })
    const select = vi.fn().mockReturnValue({ from: selectFrom })

    getOrgDbMock.mockReturnValue({ insert, select, update })

    await addEvidenceBulk([
      {
        claimId: "claim_1",
        sourceType: "git",
        sourceId: "path/new.ts",
        logicalSourceKey: "path/new.ts",
        extractionMethod: "llm",
        confidence: 0.7,
      },
    ])

    expect(insertValues).toHaveBeenCalledTimes(1)
    expect(selectWhere).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(1)
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregatedConfidence: expect.any(Number),
        lastObservedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    )
  })
})
