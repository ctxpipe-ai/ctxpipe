import { describe, expect, it } from "vitest"

import {
  caseCopies,
  caseDuplicateCount,
  foldPath,
  hideCaseDuplicateUnits,
} from "./case-duplicates.js"
import {
  hydrateKnowledgeTree,
  hydrateUnitsToProjectionClaims,
} from "./hydrate.js"

/** The units of `units` that the reads show, and the paths that they hide. */
const fold = (
  units: ReturnType<typeof tree>,
  updatedAt: ReadonlyMap<string, string>,
) => {
  const shownPath = caseCopies(
    units.map((unit) => unit.path),
    updatedAt,
  )
  return {
    units: hideCaseDuplicateUnits(units, shownPath),
    hidden: [...shownPath.keys()].sort(),
  }
}

const tree = (files: Record<string, string>) =>
  hydrateKnowledgeTree({
    workspaceId: "ws_case",
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  }).units

describe("case duplicates", () => {
  it("folds a path with NFC and lowercase", () => {
    expect(foldPath("knowledge/Café/Billing.md")).toBe(
      "knowledge/café/billing.md",
    )
  })

  it("counts each path that shares its folded path with another path", () => {
    expect(
      caseDuplicateCount([
        "knowledge/services/Billing.md",
        "knowledge/services/billing.md",
        "knowledge/services/BILLING.md",
        "knowledge/services/payments.md",
        "knowledge/café.md",
        "knowledge/café.md",
      ]),
    ).toBe(3)
    expect(caseDuplicateCount(["a.md", "b.md"])).toBe(0)
  })

  it("the old stack keeps the copy that Git changed last, and a link to the other copy goes to it", () => {
    const units = tree({
      "knowledge/services/Billing.md": "# Billing\n\nThe new text.\n",
      "knowledge/services/billing.md": "# Billing\n\nThe old text.\n",
      "knowledge/guides/deploy.md":
        "---\nkind: Guide\nclaims:\n  - to: ../services/billing.md\n    predicate: DEPENDS_ON\n    evidence: {}\n---\n\nDeploy [billing](../services/billing.md) and [it](../services/Billing.md).\n",
    })
    const folded = fold(
      units,
      new Map([
        ["knowledge/services/Billing.md", "2026-11-20T00:00:00.000Z"],
        ["knowledge/services/billing.md", "2026-11-01T00:00:00.000Z"],
      ]),
    )

    expect(folded.hidden).toEqual(["knowledge/services/billing.md"])
    expect(folded.units.map((unit) => unit.path).sort()).toEqual([
      "knowledge/guides/deploy.md",
      "knowledge/services/Billing.md",
    ])
    const shown = folded.units.find(
      (unit) => unit.path === "knowledge/services/Billing.md",
    )
    // One relation for each predicate to the copy that the read shows.
    expect(
      hydrateUnitsToProjectionClaims(folded.units).map((claim) => [
        claim.predicate,
        claim.objectId,
      ]),
    ).toEqual([
      ["DEPENDS_ON", shown?.servingId],
      ["LINKS_TO", shown?.servingId],
    ])
  })

  it("with the same commit time, the canonical lowercase path wins, then the first path in byte order", () => {
    const units = tree({
      "knowledge/BILLING.md": "# A\n",
      "knowledge/Billing.md": "# B\n",
      "knowledge/billing.md": "# C\n",
      "knowledge/Payments.md": "# D\n",
      "knowledge/PAYMENTS.md": "# E\n",
    })
    const time = "2026-11-01T00:00:00.000Z"
    const folded = fold(units, new Map(units.map((unit) => [unit.path, time])))
    expect(folded.units.map((unit) => unit.path).sort()).toEqual([
      "knowledge/PAYMENTS.md",
      "knowledge/billing.md",
    ])
    expect(folded.hidden).toHaveLength(3)
  })

  it("a copy with a commit time wins over a copy with none", () => {
    const units = tree({
      "knowledge/billing.md": "# Old\n",
      "knowledge/Billing.md": "# New\n",
    })
    const folded = fold(
      units,
      new Map([["knowledge/Billing.md", "2026-11-01T00:00:00.000Z"]]),
    )
    expect(folded.units.map((unit) => unit.path)).toEqual([
      "knowledge/Billing.md",
    ])
  })

  it("a tree with no case duplicate keeps its units, and a link to another case of a path goes to that path", () => {
    const units = tree({
      "a.md": "# A\n\n[b](B.md) and [c](c.md)\n",
      "b.md": "# B\n",
      "c.md": "# C\n",
    })
    const folded = fold(units, new Map())
    expect(folded.hidden).toEqual([])
    expect(folded.units.map((unit) => unit.path)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ])
    expect(folded.units[0]?.links).toEqual(["workspace:b.md", "c.md"])
    expect(folded.units.slice(1)).toEqual(units.slice(1))
  })
})
