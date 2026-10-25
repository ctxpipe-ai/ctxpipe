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
} from "./ingestionRetraction.js"

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
      execute: async () => {
        ops.push("update-claim-batch")
        return { rows: [] }
      },
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
    expect(ops.filter((o) => o === "update-claim")).toHaveLength(0)
    expect(ops.filter((o) => o === "update-claim-batch")).toHaveLength(1)
  })

  it("batches N multi-source survivors into one write, not N updates", async () => {
    const ops: string[] = []
    const now = new Date("2026-08-03T00:00:00.000Z")
    const claimIds = ["clm_a", "clm_b", "clm_c"]
    let selectPhase = 0
    const tx = {
      select: () => {
        const phase = selectPhase++
        return {
          from: () => ({
            innerJoin: () => ({
              where: async () =>
                claimIds.map((claimId, i) => ({
                  id: `cev_${i}`,
                  claimId,
                })),
            }),
            where: async () => {
              if (phase === 1) {
                return claimIds.map((claimId) => ({
                  claimId,
                  sourceType: "git",
                  extractionMethod: "llm",
                  confidence: 0.7,
                  observedAt: now,
                }))
              }
              return []
            },
          }),
        }
      },
      delete: () => ({
        where: async () => ({ rowCount: 1 }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            ops.push("update-claim")
          },
        }),
      }),
      execute: async () => {
        ops.push("update-claim-batch")
        return { rows: [] }
      },
    }
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        await fn(tx)
      },
    } as unknown as Db

    const { stats } = await purgeRepositoryEvidencePg(db, {
      orgId: "org_1",
      repositoryId: "repo_1",
    })

    expect(stats.claimsUpdated).toBe(3)
    expect(stats.claimsDeleted).toBe(0)
    expect(ops.filter((o) => o === "update-claim")).toHaveLength(0)
    expect(ops.filter((o) => o === "update-claim-batch")).toHaveLength(1)
  })
})
