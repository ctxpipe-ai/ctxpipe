import { describe, expect, it } from "vitest"
import {
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

  it("treats a no-op export as the current resolved tip", () => {
    expect(noOpExportUsesResolvedTip(false, "tip")).toEqual({
      commit: false,
      exportSha: "tip",
    })
    expect(noOpExportUsesResolvedTip(true, "tip")).toEqual({ commit: true })
  })
})
