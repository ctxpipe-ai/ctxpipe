import { getTableName } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"
import type { Db } from "../../db/client.js"

vi.mock("./graphProjection.js", () => ({
  retractClaimsFromGraph: vi.fn(),
  refreshClaimProjections: vi.fn(),
  deleteObjectsFromGraph: vi.fn(),
}))

import { retractConnectorPrefixInstructionUnitsPg } from "./ingestionRetraction.js"

describe("retractConnectorPrefixInstructionUnitsPg", () => {
  it("deletes connector-derived units, their claims, and nodes left orphaned", async () => {
    const deletes: string[] = []
    let selectPhase = 0
    const tx = {
      select: () => {
        const phase = selectPhase++
        return {
          from: () => ({
            where: async () => {
              if (phase === 0)
                return [{ id: "obj_unit_a" }, { id: "obj_unit_b" }]
              if (phase === 1) {
                return [
                  {
                    id: "clm_1",
                    subjectId: "obj_root_svc",
                    objectId: "obj_unit_a",
                  },
                  {
                    id: "clm_2",
                    subjectId: "obj_root_svc",
                    objectId: "obj_unit_b",
                  },
                  {
                    id: "clm_3",
                    subjectId: "obj_unit_a",
                    objectId: "obj_skill",
                  },
                ]
              }
              if (phase === 2)
                return [{ id: "cev_1" }, { id: "cev_2" }, { id: "cev_3" }]
              // orphan check: the stub root Service and the Skill lost all claims
              return [{ id: "obj_root_svc" }, { id: "obj_skill" }]
            },
          }),
        }
      },
      delete: (table: Parameters<typeof getTableName>[0]) => ({
        where: async () => {
          deletes.push(getTableName(table))
          return []
        },
      }),
    }
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<void>) => fn(tx),
    } as unknown as Db

    const result = await retractConnectorPrefixInstructionUnitsPg(db, {
      orgId: "org_1",
    })

    expect(result.unitsDeleted).toBe(2)
    expect(result.stats.claimsDeleted).toBe(3)
    expect(result.stats.deletedEvidenceRows).toBe(3)
    expect(result.stats.orphanObjectsDeleted).toBe(2)
    expect(result.graphEffects.deletedClaimIds).toEqual([
      "clm_1",
      "clm_2",
      "clm_3",
    ])
    expect(result.graphEffects.deletedObjectIds.sort()).toEqual([
      "obj_root_svc",
      "obj_skill",
      "obj_unit_a",
      "obj_unit_b",
    ])
    expect(deletes).toEqual(["claims", "objects", "objects"])
  })

  it("is a no-op when no connector-derived units exist", async () => {
    const tx = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      delete: () => {
        throw new Error("must not delete")
      },
    }
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<void>) => fn(tx),
    } as unknown as Db
    const result = await retractConnectorPrefixInstructionUnitsPg(db, {
      orgId: "org_1",
    })
    expect(result.unitsDeleted).toBe(0)
    expect(result.graphEffects.deletedClaimIds).toEqual([])
  })
})
