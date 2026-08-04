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
  purgeRepositoryEvidencePg,
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

describe("purgeRepositoryEvidencePg (set-based)", () => {
  it("bulk-deletes fully-owned claims without per-claim reconcile updates", async () => {
    const ops: string[] = []
    const claimIds = Array.from({ length: 3 }, (_, i) => `clm_${i}`)
    const evidenceRows = claimIds.map((claimId, i) => ({
      id: `cev_${i}`,
      claimId,
    }))
    const claimRows = claimIds.map((id, i) => ({
      id,
      subjectId: `obj_s_${i}`,
      objectId: `obj_o_${i}`,
    }))

    let selectPhase = 0
    const tx = {
      select: () => {
        const phase = selectPhase++
        return {
          from: () => ({
            innerJoin: () => ({
              where: async () => {
                ops.push("select-repo-evidence")
                return evidenceRows
              },
            }),
            where: async () => {
              if (phase === 1) {
                ops.push("select-remaining-evidence")
                return [] // all fully owned
              }
              if (phase === 2) {
                ops.push("select-fully-owned-claims")
                return claimRows
              }
              ops.push("select-orphan-objects")
              return claimRows.flatMap((c) => [
                { id: c.subjectId },
                { id: c.objectId },
              ])
            },
          }),
        }
      },
      delete: () => ({
        where: async () => {
          ops.push("delete")
          return { rowCount: 1 }
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            ops.push("update-claim")
          },
        }),
      }),
    }

    const db = {
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        await fn(tx)
      },
    } as unknown as Db

    const { stats, graphEffects } = await purgeRepositoryEvidencePg(db, {
      orgId: "org_1",
      repositoryId: "repo_1",
    })

    expect(stats.deletedEvidenceRows).toBe(3)
    expect(stats.claimsDeleted).toBe(3)
    expect(stats.claimsUpdated).toBe(0)
    expect(stats.orphanObjectsDeleted).toBe(6)
    expect(graphEffects.deletedClaimIds).toEqual(claimIds)
    expect(graphEffects.refreshedClaimIds).toEqual([])
    expect(ops.filter((o) => o === "update-claim")).toHaveLength(0)
    // One evidence delete + one claims delete + one objects delete (chunked once each)
    expect(ops.filter((o) => o === "delete").length).toBeGreaterThanOrEqual(3)
    expect(ops).toContain("select-remaining-evidence")
    expect(ops).toContain("select-fully-owned-claims")
  })

  it("updates multi-source residuals after deleting repo evidence", async () => {
    const ops: string[] = []
    const now = new Date("2026-08-03T00:00:00.000Z")

    let selectPhase = 0
    const tx = {
      select: () => {
        const phase = selectPhase++
        return {
          from: () => ({
            innerJoin: () => ({
              where: async () => {
                ops.push("select-repo-evidence")
                return [
                  { id: "cev_a", claimId: "clm_multi" },
                  { id: "cev_only", claimId: "clm_only" },
                ]
              },
            }),
            where: async () => {
              if (phase === 1) {
                ops.push("select-remaining-evidence")
                return [
                  {
                    claimId: "clm_multi",
                    sourceType: "git",
                    extractionMethod: "llm",
                    confidence: 0.7,
                    observedAt: now,
                  },
                ]
              }
              if (phase === 2) {
                ops.push("select-fully-owned-claims")
                return [
                  {
                    id: "clm_only",
                    subjectId: "obj_a",
                    objectId: "obj_c",
                  },
                ]
              }
              ops.push("select-orphan-objects")
              return [{ id: "obj_c" }]
            },
          }),
        }
      },
      delete: () => ({
        where: async () => {
          ops.push("delete")
          return { rowCount: 1 }
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            ops.push("update-claim")
          },
        }),
      }),
    }

    const db = {
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        await fn(tx)
      },
    } as unknown as Db

    const { stats, graphEffects } = await purgeRepositoryEvidencePg(db, {
      orgId: "org_1",
      repositoryId: "repo_1",
    })

    expect(stats.deletedEvidenceRows).toBe(2)
    expect(stats.claimsDeleted).toBe(1)
    expect(stats.claimsUpdated).toBe(1)
    expect(graphEffects.deletedClaimIds).toEqual(["clm_only"])
    expect(graphEffects.refreshedClaimIds).toEqual(["clm_multi"])
    expect(ops.filter((o) => o === "update-claim")).toHaveLength(1)
  })
})
