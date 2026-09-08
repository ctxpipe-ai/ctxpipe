import { describe, expect, it } from "vitest"
import {
  applyEffectiveValidFromToUnits,
  displayNameFromAgentsMarkdown,
  hydrateKnowledgeTree,
  hydrateUnitsToProjectionClaims,
  servingIdForKnowledgePath,
  shouldHydrateBeforeMigrationExport,
} from "./hydrate.js"

describe("hydrateKnowledgeTree", () => {
  it("uses a stable serving id per Workspace + path and skips malformed files", () => {
    const a = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const b = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const c = servingIdForKnowledgePath("ws_2", "knowledge/payments/api.md")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith("kn_")).toBe(true)

    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/payments/api.md",
          content:
            "---\nclaims:\n  - to: ../billing/ledger.md\n    predicate: DEPENDS_ON\n---\nSee [ledger](../billing/ledger.md).\n",
        },
        { path: "broken.md", content: "---\nnot closed\n" },
        {
          path: "repositories/billing.md",
          content: "---\ngit: https://github.com/acme/billing.git\n---\n",
        },
        { path: "linear/issues/PAY-1.md", content: "mirror" },
      ],
    })
    expect(result.units).toHaveLength(2)
    expect(result.units.map((unit) => unit.path).sort()).toEqual([
      "knowledge/payments/api.md",
      "linear/issues/PAY-1.md",
    ])
    expect(
      result.units.find((unit) => unit.path === "knowledge/payments/api.md")
        ?.links,
    ).toEqual(["../billing/ledger.md"])
    expect(
      result.units.find((unit) => unit.path === "knowledge/payments/api.md")
        ?.claims[0]?.to,
    ).toBe("../billing/ledger.md")
    expect(
      result.units.find((unit) => unit.path === "knowledge/payments/api.md")
        ?.confidence,
    ).toBeNull()
    expect(result.skipped).toEqual([{ path: "broken.md", reason: "malformed" }])
    expect(result.linked).toEqual([
      {
        path: "repositories/billing.md",
        git: "https://github.com/acme/billing",
        branch: null,
      },
    ])
  })

  it("keeps the first linked remote and skips duplicate git URLs", () => {
    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "repositories/billing.md",
          content: "---\ngit: https://github.com/acme/billing.git\n---\n",
        },
        {
          path: "repositories/billing-dup.md",
          content: "---\ngit: https://github.com/acme/billing.git\n---\n",
        },
      ],
    })
    expect(result.linked).toHaveLength(1)
    expect(result.skipped).toEqual([
      { path: "repositories/billing-dup.md", reason: "malformed" },
    ])
  })
})

it("does not treat a missing export SHA as a hydrate blocker", () => {
  expect(shouldHydrateBeforeMigrationExport(null)).toBe(true)
  expect(shouldHydrateBeforeMigrationExport("export")).toBe(false)
})

describe("applyEffectiveValidFromToUnits", () => {
  it("copies the introducing-commit timestamp onto git-SHA valid_from", () => {
    expect(
      applyEffectiveValidFromToUnits(
        [
          {
            path: "knowledge/a.md",
            servingId: "kn_a",
            body: "A",
            links: [],
            claims: [
              {
                to: "./b.md",
                predicate: "DEPENDS_ON",
                confidence: 0.8,
                validFrom: "abc123",
                validTo: null,
                source: "git",
              },
            ],
          },
        ],
        new Map([["knowledge/a.md", "2026-08-16T12:00:00.000Z"]]),
      )[0]?.claims[0]?.validFrom,
    ).toBe("2026-08-16T12:00:00.000Z")
  })
})

describe("hydrateUnitsToProjectionClaims", () => {
  it("projects layer-2 claims and unresolved-safe LINKS_TO from units", () => {
    const api = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const ledger = servingIdForKnowledgePath(
      "ws_1",
      "knowledge/billing/ledger.md",
    )
    const claims = hydrateUnitsToProjectionClaims(
      [
        {
          path: "knowledge/payments/api.md",
          servingId: api,
          body: "See [ledger](../billing/ledger.md).",
          links: ["../billing/ledger.md"],
          claims: [
            {
              to: "../billing/ledger.md",
              predicate: "DEPENDS_ON",
              confidence: 0.8,
              validFrom: "abc123",
              validTo: null,
              source: "git",
            },
          ],
        },
        {
          path: "knowledge/billing/ledger.md",
          servingId: ledger,
          body: "Ledger",
          links: [],
          claims: [],
        },
      ],
      "2026-08-16T12:00:00.000Z",
    )
    expect(claims).toEqual([
      expect.objectContaining({
        subjectId: api,
        objectId: ledger,
        predicate: "DEPENDS_ON",
        aggregatedConfidence: 0.8,
        validFrom: "2026-08-16T12:00:00.000Z",
      }),
    ])
  })

  it("copies file-level confidence onto claims that omit it", () => {
    const parsed = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/instructions/local-memory.md",
          content:
            "---\nkind: InstructionUnit\nconfidence: 0.62\nclaims:\n  - to: ../skills/local-memory.md\n    predicate: MEMBER_OF_PRIMARY\n---\nBody\n",
        },
        {
          path: "knowledge/skills/local-memory.md",
          content: "---\nkind: Skill\n---\nSkill\n",
        },
      ],
    })
    expect(parsed.units[0]?.confidence).toBe(0.62)
    const claims = hydrateUnitsToProjectionClaims(parsed.units)
    expect(claims[0]?.aggregatedConfidence).toBe(0.62)
  })
})

describe("displayNameFromAgentsMarkdown", () => {
  it("reads a valid name and ignores malformed or empty files", () => {
    expect(displayNameFromAgentsMarkdown("---\nname: Docs\n---\n")).toBe("Docs")
    expect(displayNameFromAgentsMarkdown("---\nname:   \n---\n")).toBeNull()
    expect(displayNameFromAgentsMarkdown("---\nnot closed\n")).toBeNull()
    expect(displayNameFromAgentsMarkdown("# No front matter\n")).toBeNull()
  })
})
