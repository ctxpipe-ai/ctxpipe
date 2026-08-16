import { describe, expect, it } from "vitest"
import {
  importedObjectMarkdown,
  importKeyForExportedObject,
  importKeyFromDedup,
  MIGRATION_EXPORT_KIND,
  migrationExportFiles,
  noOpExportUsesResolvedTip,
  objectTitleFromPayload,
  planMigrationExport,
  repositoryIdFromDedup,
  workspaceByRepositoryUrl,
} from "./migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

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

  it("extracts a repository id from ingest dedup keys", () => {
    expect(repositoryIdFromDedup("inu:repo_abc:./:readme")).toBe("repo_abc")
    expect(repositoryIdFromDedup("svc:repo_abc:./")).toBe("repo_abc")
    expect(repositoryIdFromDedup("pat:repo_abc:./:CQRS")).toBe("repo_abc")
    expect(repositoryIdFromDedup("evd:repo_abc:./:note")).toBe("repo_abc")
    expect(repositoryIdFromDedup("obj_legacy")).toBeNull()
    expect(
      importKeyForExportedObject({
        id: "obj_1",
        deduplicationKey: null,
        payload: { name: "Billing", summary: "Ledger" },
      }),
    ).toMatch(/^src:[0-9a-f]{16}$/)
    expect(
      importKeyForExportedObject({
        id: "obj_1",
        deduplicationKey: "legacy:obj_1",
        payload: { name: "Billing" },
      }),
    ).not.toContain("obj_")
    expect(objectTitleFromPayload({ name: "Billing API" })).toBe("Billing API")
  })

  it("maps a workspace-repository git URL to that Workspace", () => {
    const map = workspaceByRepositoryUrl({
      repositories: [
        { id: "repo_app", gitUrl: "https://github.com/acme/app.git" },
        { id: "repo_other", gitUrl: "https://github.com/acme/other.git" },
      ],
      workspaces: [
        { id: "ws_app", workspaceRepositoryUrl: "https://github.com/acme/app" },
      ],
      normalizeUrl: normalizeWorkspaceRepositoryUrl,
    })
    expect(map.get("repo_app")).toBe("ws_app")
    expect(map.get("repo_other")).toBeUndefined()
  })

  it("exports assigned objects and skips a cross-workspace claim", () => {
    const planned = planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([
        ["repo_app", "ws_app"],
        ["repo_other", "ws_other"],
      ]),
      objects: [
        {
          id: "obj_1",
          deduplicationKey: "svc:repo_app:./",
          payload: { name: "Billing", summary: "Ledger lives here." },
        },
        {
          id: "obj_2",
          deduplicationKey: "svc:repo_other:./",
          payload: { name: "Other" },
        },
      ],
      claims: [
        {
          subjectId: "obj_1",
          objectId: "obj_2",
          predicate: "DEPENDS_ON",
          aggregatedConfidence: 0.7,
          validFrom: "2026-01-01",
          validTo: null,
        },
      ],
      existingKnowledge: [],
      linkedUrls: ["https://github.com/acme/docs"],
    })
    expect(planned.wouldChange).toBe(true)
    expect(planned.files.map((file) => file.path)).toEqual([
      "knowledge/imported/billing.md",
      "repositories/docs.md",
    ])
    expect(planned.files[0]?.content).toContain("import_key: svc:repo_app:./")
    expect(planned.files[0]?.content).not.toContain("DEPENDS_ON")
    expect(planned.files[0]?.content).not.toContain("obj_")
  })

  it("merges into an existing import_key file and no-ops when unchanged", () => {
    const existing = importedObjectMarkdown({
      title: "Billing",
      body: "Ledger lives here.",
      importKey: "svc:repo_app:./",
    })
    const planned = planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          deduplicationKey: "svc:repo_app:./",
          payload: { name: "Billing", summary: "Ledger lives here." },
        },
      ],
      claims: [],
      existingKnowledge: [
        { path: "knowledge/payments/billing.md", content: existing },
      ],
      linkedUrls: [],
    })
    expect(planned.files[0]?.path).toBe("knowledge/payments/billing.md")
    expect(planned.wouldChange).toBe(false)
  })

  it("appends into an unkeyed occupant instead of replacing it", () => {
    const planned = planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          deduplicationKey: "svc:repo_app:./",
          payload: {
            name: "Billing",
            summary: "# Billing\n\nAlso the ledger.",
          },
        },
      ],
      claims: [],
      existingKnowledge: [
        {
          path: "knowledge/imported/billing.md",
          content: "# Billing\n\nLedger lives here.",
        },
      ],
      linkedUrls: [],
    })
    expect(planned.files[0]?.path).toBe("knowledge/imported/billing.md")
    expect(planned.files[0]?.content).toContain("Ledger lives here.")
    expect(planned.files[0]?.content).toContain("Also the ledger.")
    expect(planned.files[0]?.content).toContain("import_key: svc:repo_app:./")
  })
})
