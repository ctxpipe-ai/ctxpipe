import { describe, expect, it } from "vitest"

import {
  claimsUpgradeFiles,
  claimsUpgradeRemainder,
  hydrateWriteJobRemainders,
  hydrateWriteJobsToEnqueue,
  importKeyCleanupFiles,
  kindsToRetryAfterHydrate,
  validFromPersistFiles,
  validFromPersistRemainder,
} from "./hydrate-write-jobs.js"
import type { HydrateUnit } from "./hydrate.js"

const unit = (overrides: Partial<HydrateUnit>): HydrateUnit => ({
  path: "knowledge/a.md",
  servingId: "kn_a",
  title: null,
  source: "authored",
  updatedAt: null,
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

  it("does not count the FROM_SOURCE claim of the sources front matter, which has no valid_from to write", () => {
    expect(
      validFromPersistRemainder([
        unit({
          claims: [
            {
              to: "workspace:sources/github/acme/api.md",
              predicate: "FROM_SOURCE",
              confidence: 1,
              validFrom: null,
              validTo: null,
              source: "git",
            },
          ],
        }),
      ]),
    ).toBe(0)
  })

  it("enqueues remaining kinds when writable or paused, not after relink", () => {
    expect(
      hydrateWriteJobsToEnqueue({
        units: [unit({})],
        writeStatus: "writable",
        jobGeneration: 1,
        desiredGeneration: 1,
      }),
    ).toEqual(["claims_upgrade"])
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
        writeStatus: "unknown",
        jobGeneration: 1,
        desiredGeneration: 1,
      }),
    ).toEqual(["claims_upgrade"])
    expect(
      hydrateWriteJobsToEnqueue({
        units: [unit({})],
        writeStatus: "writable",
        jobGeneration: 1,
        desiredGeneration: 2,
      }),
    ).toEqual([])
  })

  it("retries a kind only when that remainder shrank", () => {
    const after = hydrateWriteJobRemainders({
      units: [unit({})],
    })
    expect(after.claims_upgrade).toBe(1)
    expect(
      kindsToRetryAfterHydrate({
        remaining: ["claims_upgrade"],
        remainderBefore: { claims_upgrade: 2 },
        remainderAfter: after,
        attemptsForSha: { claims_upgrade: 1 },
      }),
    ).toEqual(["claims_upgrade"])
    expect(
      kindsToRetryAfterHydrate({
        remaining: ["claims_upgrade"],
        remainderBefore: { claims_upgrade: 1 },
        remainderAfter: after,
        attemptsForSha: { claims_upgrade: 1 },
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

  it("writes the introducing commit timestamp onto claims that lack valid_from", () => {
    const files = validFromPersistFiles({
      introducingCommitTimestamp: "2026-08-16T12:00:00.000Z",
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
    expect(files[0]?.content).toContain("valid_from: 2026-08-16T12:00:00.000Z")
  })

  it("strips import_key and leaves claims and body intact", () => {
    const files = importKeyCleanupFiles([
      {
        path: "knowledge/services/billing.md",
        content:
          "---\nimport_key: svc:repo_app:./\nkind: Service\nclaims:\n  - to: ../payments/api.md\n    predicate: DEPENDS_ON\n    confidence: 0.7\n---\n\n# Billing\n\nLedger lives here.\n",
      },
      {
        path: "knowledge/services/other.md",
        content: "---\nkind: Service\n---\n\n# Other\n",
      },
    ])
    expect(files).toHaveLength(1)
    expect(files[0]?.content).not.toContain("import_key:")
    expect(files[0]?.content).toContain("kind: Service")
    expect(files[0]?.content).toContain("predicate: DEPENDS_ON")
    expect(files[0]?.content).toContain("# Billing")
    expect(files[0]?.content).toContain("Ledger lives here.")
  })
})
