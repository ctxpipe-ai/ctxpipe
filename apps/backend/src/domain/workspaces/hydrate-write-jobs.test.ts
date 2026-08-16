import { describe, expect, it } from "vitest"
import type { HydrateUnit } from "./hydrate.js"
import {
  claimsUpgradeFiles,
  claimsUpgradeRemainder,
  hydrateWriteJobsToEnqueue,
  opsFolderMapFiles,
  opsFolderMapRemainder,
  validFromPersistFiles,
  validFromPersistRemainder,
} from "./hydrate-write-jobs.js"

const unit = (overrides: Partial<HydrateUnit>): HydrateUnit => ({
  path: "knowledge/a.md",
  servingId: "kn_a",
  body: "See [ledger](../billing/ledger.md).",
  links: ["../billing/ledger.md"],
  claims: [],
  ...overrides,
})

describe("hydrate write remainders", () => {
  it("counts markdown links that are not yet claims", () => {
    expect(claimsUpgradeRemainder([unit({})])).toBe(1)
    expect(
      claimsUpgradeRemainder([
        unit({
          claims: [
            {
              to: "../billing/ledger.md",
              predicate: null,
              confidence: null,
              validFrom: null,
              validTo: null,
              source: null,
            },
          ],
        }),
      ]),
    ).toBe(0)
  })

  it("counts claims missing valid_from", () => {
    expect(
      validFromPersistRemainder([
        unit({
          claims: [
            {
              to: "svc",
              predicate: "owns",
              confidence: 0.5,
              validFrom: null,
              validTo: null,
              source: null,
            },
          ],
        }),
      ]),
    ).toBe(1)
    expect(validFromPersistRemainder([unit({ claims: [] })])).toBe(0)
  })

  it("counts a missing folder-map marker", () => {
    expect(opsFolderMapRemainder(null)).toBe(1)
    expect(opsFolderMapRemainder("# Notes\n")).toBe(1)
    expect(opsFolderMapRemainder("<!-- ctxpipe:folder-map -->")).toBe(0)
  })

  it("enqueues remaining kinds only when the write gate is open", () => {
    expect(
      hydrateWriteJobsToEnqueue({
        units: [unit({})],
        agentsMd: null,
        writeStatus: "writable",
        jobGeneration: 1,
        desiredGeneration: 1,
      }),
    ).toEqual(["claims_upgrade", "ops_folder_map"])
    expect(
      hydrateWriteJobsToEnqueue({
        units: [
          unit({
            path: "knowledge/payments/api.md",
            links: ["../billing/ledger.md"],
          }),
          unit({
            path: "knowledge/billing/ledger-v2.md",
            links: [],
            body: "Ledger",
          }),
        ],
        agentsMd: "<!-- ctxpipe:folder-map -->",
        writeStatus: "writable",
        jobGeneration: 1,
        desiredGeneration: 1,
        previousPaths: [
          "knowledge/billing/ledger.md",
          "knowledge/payments/api.md",
        ],
        extractRemainder: 1,
      }),
    ).toEqual(["claims_upgrade", "rename_rewrite", "extract_ingest"])
    expect(
      hydrateWriteJobsToEnqueue({
        units: [unit({})],
        agentsMd: null,
        writeStatus: "unknown",
        jobGeneration: 1,
        desiredGeneration: 1,
      }),
    ).toEqual([])
  })
})

describe("hydrate write files", () => {
  it("upgrades markdown links into claims front matter", () => {
    const files = claimsUpgradeFiles({
      files: [
        {
          path: "knowledge/a.md",
          content: "---\nname: A\n---\n\nSee [ledger](../billing/ledger.md).\n",
        },
      ],
      units: [unit({})],
    })
    expect(files).toHaveLength(1)
    expect(files[0]?.content).toContain("to: ../billing/ledger.md")
  })

  it("writes the introducing SHA onto claims that lack valid_from", () => {
    const files = validFromPersistFiles({
      introducingSha: "abc123",
      files: [
        {
          path: "knowledge/a.md",
          content: "---\nclaims:\n  - to: svc\n---\n\nBody\n",
        },
      ],
      units: [
        unit({
          body: "Body",
          links: [],
          claims: [
            {
              to: "svc",
              predicate: null,
              confidence: null,
              validFrom: null,
              validTo: null,
              source: null,
            },
          ],
        }),
      ],
    })
    expect(files[0]?.content).toContain("valid_from: abc123")
  })

  it("writes a folder-map section into AGENTS.md", () => {
    const files = opsFolderMapFiles({
      displayName: "Docs",
      existingAgentsMd: "---\nname: Docs\n---\n\nHello.\n",
    })
    expect(files[0]?.content).toContain("<!-- ctxpipe:folder-map -->")
  })
})
