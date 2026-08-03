import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Db } from "../../db/client.js"

const retractClaimsFromGraphMock = vi.hoisted(() => vi.fn())
const refreshClaimProjectionsMock = vi.hoisted(() => vi.fn())
const deleteObjectsFromGraphMock = vi.hoisted(() => vi.fn())

vi.mock("./graphProjection.js", () => ({
  retractClaimsFromGraph: retractClaimsFromGraphMock,
  refreshClaimProjections: refreshClaimProjectionsMock,
  deleteObjectsFromGraph: deleteObjectsFromGraphMock,
}))

import {
  applyIngestionRetractionGraphEffects,
  retractIngestionForDiffPg,
} from "./ingestionRetraction.js"

const noopDb = {} as Db

function dbWithEmptyEvidenceMatches() {
  let transactionCalls = 0
  const where = () => Promise.resolve([])
  const innerJoin = () => ({ where })
  const from = () => ({ innerJoin })
  const select = () => ({ from })
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      transactionCalls++
      await fn({ select })
    },
  } as unknown as Db
  return { db, transactionCalls: () => transactionCalls }
}

describe("applyIngestionRetractionGraphEffects", () => {
  beforeEach(() => {
    retractClaimsFromGraphMock.mockReset().mockResolvedValue(undefined)
    refreshClaimProjectionsMock.mockReset().mockResolvedValue(2)
    deleteObjectsFromGraphMock.mockReset().mockResolvedValue(undefined)
  })

  it("batches retract, refresh, and delete instead of per-id loops", async () => {
    const stats = await applyIngestionRetractionGraphEffects({
      deletedClaimIds: ["c1", "c2", "c1"],
      refreshedClaimIds: ["c3", "c4"],
      deletedObjectIds: ["o1"],
    })

    expect(retractClaimsFromGraphMock).toHaveBeenCalledTimes(1)
    expect(retractClaimsFromGraphMock).toHaveBeenCalledWith(["c1", "c2"])
    expect(refreshClaimProjectionsMock).toHaveBeenCalledTimes(1)
    expect(refreshClaimProjectionsMock).toHaveBeenCalledWith(["c3", "c4"])
    expect(deleteObjectsFromGraphMock).toHaveBeenCalledTimes(1)
    expect(deleteObjectsFromGraphMock).toHaveBeenCalledWith(["o1"])
    expect(stats).toEqual({
      graphEdgesDeleted: 2,
      graphClaimsRefreshed: 2,
      graphOrphanObjectsDeleted: 1,
    })
  })
})

describe("retractIngestionForDiffPg", () => {
  it("no-ops on full ingest mode", async () => {
    const { stats, graphEffects } = await retractIngestionForDiffPg(noopDb, {
      orgId: "org_1",
      repositoryId: "repo_1",
      ingestMode: "full",
      changedPaths: ["src/changed.ts"],
      deletedPaths: ["src/removed.ts"],
      renames: [{ from: "a", to: "b" }],
    })
    expect(stats).toEqual({
      renamedEvidenceRows: 0,
      deletedEvidenceRows: 0,
      claimsUpdated: 0,
      claimsDeleted: 0,
      orphanObjectsDeleted: 0,
      graphEdgesDeleted: 0,
      graphClaimsRefreshed: 0,
      graphOrphanObjectsDeleted: 0,
    })
    expect(graphEffects).toEqual({
      deletedClaimIds: [],
      refreshedClaimIds: [],
      deletedObjectIds: [],
    })
  })

  it("no-ops on partial ingest when diff lists are empty", async () => {
    const { stats } = await retractIngestionForDiffPg(noopDb, {
      orgId: "org_1",
      repositoryId: "repo_1",
      ingestMode: "partial",
      changedPaths: [],
      deletedPaths: [],
      renames: [],
    })
    expect(stats.deletedEvidenceRows).toBe(0)
    expect(stats.renamedEvidenceRows).toBe(0)
  })

  it("processes changed-only partial diffs so stale evidence can be replaced", async () => {
    const { db, transactionCalls } = dbWithEmptyEvidenceMatches()

    const { stats } = await retractIngestionForDiffPg(db, {
      orgId: "org_1",
      repositoryId: "repo_1",
      ingestMode: "partial",
      changedPaths: ["src/routes.ts"],
      deletedPaths: [],
      renames: [],
    })

    expect(transactionCalls()).toBe(1)
    expect(stats.deletedEvidenceRows).toBe(0)
    expect(stats.renamedEvidenceRows).toBe(0)
  })
})
