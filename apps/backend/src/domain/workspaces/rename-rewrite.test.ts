import { describe, expect, it } from "vitest"
import {
  pairRenames,
  relativeLink,
  renameRewriteFiles,
  renameRewriteRemainder,
  renameSimilarity,
} from "./rename-rewrite.js"

describe("rename rewrite", () => {
  it("pairs a 50% similar path-id change and skips many-to-one", () => {
    expect(
      renameSimilarity({
        fromPath: "knowledge/billing/ledger.md",
        toPath: "knowledge/billing/ledger-v2.md",
      }),
    ).toBeGreaterThanOrEqual(0.5)
    expect(
      pairRenames({
        previousPaths: ["knowledge/billing/ledger.md"],
        currentPaths: ["knowledge/billing/ledger-v2.md"],
      }),
    ).toEqual([
      {
        from: "knowledge/billing/ledger.md",
        to: "knowledge/billing/ledger-v2.md",
      },
    ])
    expect(
      pairRenames({
        previousPaths: [
          "knowledge/billing/ledger.md",
          "knowledge/billing/ledger-old.md",
        ],
        currentPaths: ["knowledge/billing/ledger-v2.md"],
      }),
    ).toEqual([])
  })

  it("rewrites relative links to the new path", () => {
    expect(
      relativeLink("knowledge/payments/api.md", "knowledge/billing/ledger.md"),
    ).toBe("../billing/ledger.md")
    const files = renameRewriteFiles({
      previousPaths: ["knowledge/billing/ledger.md"],
      currentPaths: ["knowledge/billing/ledger-v2.md"],
      units: [],
      files: [
        {
          path: "knowledge/payments/api.md",
          content: "See [ledger](../billing/ledger.md) and claims later.\n",
        },
      ],
    })
    expect(files).toEqual([
      {
        path: "knowledge/payments/api.md",
        content: "See [ledger](../billing/ledger-v2.md) and claims later.\n",
      },
    ])
    expect(
      renameRewriteRemainder({
        previousPaths: ["knowledge/billing/ledger.md"],
        currentPaths: ["knowledge/billing/ledger-v2.md"],
        units: [
          {
            path: "knowledge/payments/api.md",
            servingId: "kn_a",
            body: "See ledger",
            links: ["../billing/ledger.md"],
            claims: [],
          },
        ],
      }),
    ).toBe(1)
  })
})
