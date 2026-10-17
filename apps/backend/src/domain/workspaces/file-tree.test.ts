import { describe, expect, it } from "vitest"
import { fileTreeFromPaths } from "./file-tree.js"

describe("fileTreeFromPaths", () => {
  it("nests knowledge files under folders", () => {
    expect(
      fileTreeFromPaths([
        "knowledge/billing/ledger.md",
        "knowledge/payments/api.md",
        "AGENTS.md",
      ]),
    ).toEqual([
      { name: "AGENTS.md", path: "AGENTS.md" },
      {
        name: "knowledge",
        path: "knowledge",
        children: [
          {
            name: "billing",
            path: "knowledge/billing",
            children: [
              {
                name: "ledger.md",
                path: "knowledge/billing/ledger.md",
              },
            ],
          },
          {
            name: "payments",
            path: "knowledge/payments",
            children: [{ name: "api.md", path: "knowledge/payments/api.md" }],
          },
        ],
      },
    ])
  })
})
