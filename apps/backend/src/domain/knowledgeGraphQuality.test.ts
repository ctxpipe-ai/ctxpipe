import { describe, expect, it } from "vitest"
import type { Db } from "../db/client.js"
import { computeKnowledgeGraphQuality } from "./knowledgeGraphQuality.js"

describe("computeKnowledgeGraphQuality", () => {
  it("derives join density, orphan rate, and evidence per claim from counts", async () => {
    const answers = [
      { rows: [{ objects: "10", claims: "12" }] },
      {
        rows: [
          { kind: "Service", c: "4" },
          { kind: "File", c: "6" },
        ],
      },
      {
        rows: [
          { predicate: "PART_OF", c: "8" },
          { predicate: "MODIFIED", c: "4" },
        ],
      },
      { rows: [{ c: "3" }] },
      { rows: [{ c: "1" }] },
      { rows: [{ c: "12" }] },
      { rows: [{ c: "0" }] },
    ]
    let call = 0
    const db = { execute: async () => answers[call++] } as unknown as Db

    const quality = await computeKnowledgeGraphQuality(db, "org_1")

    expect(quality).toEqual({
      totalObjects: 10,
      totalClaims: 12,
      multiSourceObjects: 3,
      joinDensity: 0.3,
      orphanObjects: 1,
      orphanRate: 0.1,
      evidenceRowsPerClaim: 1,
      connectorInstructionUnits: 0,
      kinds: { Service: 4, File: 6 },
      predicates: { PART_OF: 8, MODIFIED: 4 },
    })
  })

  it("returns zero ratios for an empty graph and accepts array-shaped results", async () => {
    const answers: unknown[] = [
      [{ objects: 0, claims: 0 }],
      [],
      [],
      [{ c: 0 }],
      [{ c: 0 }],
      [{ c: 0 }],
      [{ c: 0 }],
    ]
    let call = 0
    const db = { execute: async () => answers[call++] } as unknown as Db
    const quality = await computeKnowledgeGraphQuality(db, "org_1")
    expect(quality.joinDensity).toBe(0)
    expect(quality.orphanRate).toBe(0)
    expect(quality.evidenceRowsPerClaim).toBe(0)
    expect(quality.kinds).toEqual({})
  })
})
