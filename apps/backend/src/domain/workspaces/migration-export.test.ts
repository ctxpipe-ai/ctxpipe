import { describe, expect, it } from "vitest"
import {
  importedObjectMarkdown,
  importKeyFromDedup,
  MIGRATION_EXPORT_KIND,
  migrationExportFiles,
  noOpExportUsesResolvedTip,
} from "./migration-export.js"

describe("migration export", () => {
  it("writes knowledge/imported and repositories/*.md", () => {
    expect(MIGRATION_EXPORT_KIND).toBe("migration_export")
    const files = migrationExportFiles({
      imported: [{ slug: "billing", body: "Billing\n" }],
      takenPaths: ["knowledge/imported/billing.md"],
      linkedUrls: ["https://github.com/acme/app.git"],
    })
    expect(files.map((file) => file.path)).toEqual([
      "knowledge/imported/billing-2.md",
      "repositories/app.md",
    ])
  })

  it("writes import_key and claim temporality without obj_ jargon", () => {
    expect(importKeyFromDedup("src:billing")).toBe("src:billing")
    const md = importedObjectMarkdown({
      title: "Billing",
      body: "Ledger lives here.",
      importKey: "src:billing",
      claims: [
        {
          to: "../payments/api.md",
          predicate: "DEPENDS_ON",
          confidence: 0.8,
          validFrom: "2026-01-01",
        },
      ],
    })
    expect(md).toContain("import_key: src:billing")
    expect(md).toContain("valid_from: 2026-01-01")
    expect(md).not.toContain("obj_")
  })

  it("treats a no-op export as the current resolved tip", () => {
    expect(noOpExportUsesResolvedTip(false, "tip")).toEqual({
      commit: false,
      exportSha: "tip",
    })
    expect(noOpExportUsesResolvedTip(true, "tip")).toEqual({ commit: true })
  })
})
