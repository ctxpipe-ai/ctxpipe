import { describe, expect, it } from "vitest"
import {
  applyEffectiveValidFromToUnits,
  displayNameFromAgentsMarkdown,
  hydrateIsNoop,
  hydrateKnowledgeTree,
  hydrateReadPlan,
  hydrateReadsStoredDesiredSha,
  hydrateUnitsToProjectionClaims,
  servingIdForKnowledgePath,
  shouldHydrateBeforeMigrationExport,
  shouldReplaceKnowledgeProjection,
  workspaceHydrateInFlight,
  workspaceHydrateView,
  workspaceProjectionReady,
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

  it("is a no-op only when URL and SHA already match the desired projection", () => {
    expect(
      hydrateIsNoop({
        activeProjectionUrl: "https://github.com/acme/docs",
        activeProjectionSha: "abc",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
      }),
    ).toBe(true)
    expect(
      hydrateIsNoop({
        activeProjectionUrl: "https://github.com/acme/old",
        activeProjectionSha: "abc",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
      }),
    ).toBe(false)
    expect(
      shouldReplaceKnowledgeProjection({
        activeProjectionUrl: "https://github.com/acme/docs",
        activeProjectionSha: "abc",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "abc",
      }),
    ).toBe(false)
    expect(
      shouldReplaceKnowledgeProjection({
        activeProjectionUrl: "https://github.com/acme/docs",
        activeProjectionSha: "abc",
        desiredUrl: "https://github.com/acme/docs",
        desiredSha: "def",
      }),
    ).toBe(true)
  })
})

describe("workspaceProjectionReady", () => {
  it("serves the last activated SHA even while relink hydrate is pending", () => {
    expect(
      workspaceProjectionReady({
        hydrateStatus: "pending",
        activeProjectionSha: null,
      }),
    ).toBe(false)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "ready",
        activeProjectionSha: null,
      }),
    ).toBe(false)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "ready",
        activeProjectionSha: "abc",
        migrationExportSha: "abc",
      }),
    ).toBe(true)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "pending",
        activeProjectionSha: "aaa",
        migrationExportSha: "aaa",
      }),
    ).toBe(true)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "pending",
        activeProjectionSha: "aaa",
      }),
    ).toBe(false)
    expect(
      workspaceProjectionReady({
        hydrateStatus: "ready",
        activeProjectionSha: "aaa",
        migrationExportSha: "export",
      }),
    ).toBe(true)
  })

  it("does not hydrate a random tip before the migration-export SHA exists", () => {
    expect(shouldHydrateBeforeMigrationExport(null)).toBe(true)
    expect(shouldHydrateBeforeMigrationExport("export")).toBe(false)
  })
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
        "2026-08-16T12:00:00.000Z",
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
})

describe("workspaceHydrateView", () => {
  it("is waiting for a tip while pending with no desired SHA", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "pending",
        desiredSha: null,
        hydrateError: null,
      }),
    ).toBe("waiting_for_tip")
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "pending",
        desiredSha: null,
        hydrateError: null,
      }),
    ).toBe(true)
  })

  it("is hydrating when a desired SHA is not the active projection", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "pending",
        desiredSha: "abc123def456",
        activeProjectionSha: null,
        hydrateError: null,
      }),
    ).toBe("hydrating")
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "pending",
        desiredSha: "abc123def456",
        activeProjectionSha: null,
      }),
    ).toBe(true)
    expect(
      workspaceHydrateView({
        hydrateStatus: "ready",
        desiredSha: "bbb",
        activeProjectionSha: "aaa",
        hydrateError: null,
      }),
    ).toBe("hydrating")
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "ready",
        desiredSha: "bbb",
        activeProjectionSha: "aaa",
      }),
    ).toBe(true)
  })

  it("is failed when pending still carries a hydrateError", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "pending",
        desiredSha: "87797371c413",
        activeProjectionSha: null,
        hydrateError: "Waiting for the first knowledge export to land in git.",
      }),
    ).toBe("failed")
  })

  it("is failed when hydrateStatus is failed", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "failed",
        desiredSha: null,
        hydrateError: "getLogger: no logger in context.",
      }),
    ).toBe("failed")
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "failed",
        desiredSha: null,
        hydrateError: "getLogger: no logger in context.",
      }),
    ).toBe(false)
  })

  it("is ready when status is ready and SHAs match", () => {
    expect(
      workspaceHydrateView({
        hydrateStatus: "ready",
        desiredSha: "abc123def456",
        activeProjectionSha: "abc123def456",
        hydrateError: null,
      }),
    ).toBe("ready")
    expect(
      workspaceHydrateInFlight({
        hydrateStatus: "ready",
        desiredSha: "abc123def456",
        activeProjectionSha: "abc123def456",
      }),
    ).toBe(false)
  })
})

describe("hydrateReadsStoredDesiredSha", () => {
  it("reads the stored desired SHA, not a moving default branch", () => {
    expect(hydrateReadsStoredDesiredSha("abc123")).toBe("abc123")
    expect(hydrateReadsStoredDesiredSha("  ")).toBeNull()
    expect(hydrateReadsStoredDesiredSha(null)).toBeNull()
  })

  it("clones non-GitHub remotes at the stored SHA", () => {
    expect(hydrateReadPlan("https://github.com/acme/docs.git")).toEqual({
      via: "github",
    })
    expect(hydrateReadPlan("https://gitlab.com/acme/docs.git")).toEqual({
      via: "git_clone",
    })
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
