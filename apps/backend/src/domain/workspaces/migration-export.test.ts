import { describe, expect, it } from "vitest"
import {
  completedNoOpExportSha,
  importedObjectMarkdown,
  importKeyForExportedObject,
  importKeyFromDedup,
  isoDate,
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
  it("writes knowledge/<area>/<unit>.md and repositories/*.md", () => {
    expect(MIGRATION_EXPORT_KIND).toBe("migration_export")
    const files = migrationExportFiles({
      imported: [{ slug: "billing", body: "Billing\n", area: "services" }],
      takenPaths: ["knowledge/services/billing.md"],
      linkedUrls: ["https://github.com/acme/app.git"],
    })
    expect(files.map((file) => file.path)).toEqual([
      "knowledge/services/billing-2.md",
      "repositories/app.md",
    ])
  })

  it("writes import_key and claim temporality without obj_ jargon", () => {
    expect(importKeyFromDedup("src:billing")).toBe("src:billing")
    const md = importedObjectMarkdown({
      title: "Billing",
      body: "Ledger lives here.",
      importKey: "src:billing",
      kind: "Service",
      confidence: 0.62,
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
    expect(md).toContain("kind: Service")
    expect(md).toContain("confidence: 0.62")
    expect(md).toContain("generated_by: ctxpipe")
    expect(md).toContain("valid_from: 2026-01-01")
    expect(md).not.toContain("obj_")
  })

  it("serializes claim windows as UTC instants", () => {
    expect(isoDate(new Date("2026-01-01T12:30:00.000Z"))).toBe(
      "2026-01-01T12:30:00.000Z",
    )
    expect(isoDate("2026-01-01T12:30:00.000Z")).toBe("2026-01-01T12:30:00.000Z")
  })

  it("treats a no-op export as the current resolved tip", () => {
    expect(noOpExportUsesResolvedTip(false, "tip")).toEqual({
      commit: false,
      exportSha: "tip",
    })
    expect(noOpExportUsesResolvedTip(true, "tip")).toEqual({ commit: true })
    expect(
      completedNoOpExportSha(noOpExportUsesResolvedTip(false, "tip")),
    ).toBe("tip")
    expect(completedNoOpExportSha(noOpExportUsesResolvedTip(true, "tip"))).toBe(
      null,
    )
    expect(
      completedNoOpExportSha(noOpExportUsesResolvedTip(false, "  ")),
    ).toBeNull()
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

  it("exports assigned objects and skips a cross-workspace claim", async () => {
    const planned = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([
        ["repo_app", "ws_app"],
        ["repo_other", "ws_other"],
      ]),
      objects: [
        {
          id: "obj_1",
          kind: "Service",
          deduplicationKey: "svc:repo_app:./",
          payload: { name: "Billing", summary: "Ledger lives here." },
        },
        {
          id: "obj_2",
          kind: "Service",
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
      "knowledge/services/billing.md",
      "repositories/docs.md",
    ])
    expect(planned.files[0]?.content).toContain("import_key: svc:repo_app:./")
    expect(planned.files[0]?.content).toContain("kind: Service")
    expect(planned.files[0]?.content).toContain("generated_by: ctxpipe")
    expect(planned.files[0]?.content).not.toContain("DEPENDS_ON")
    expect(planned.files[0]?.content).not.toContain("obj_")
  })

  it("serializes a same-workspace claim with confidence and a body link", async () => {
    const planned = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_svc",
          kind: "Service",
          deduplicationKey: "svc:repo_app:./",
          payload: { name: "Billing", summary: "Ledger lives here." },
        },
        {
          id: "obj_inu",
          kind: "InstructionUnit",
          deduplicationKey: "inu:repo_app:./:readme",
          payload: {
            title: "Local memory initialization",
            summary: "Initialize a local ctxpipe-memory MCP server.",
            intent: "enable local context storage without a hosted account",
            path: "README.md",
            sourceExcerpt: "Add a ctxpipe-memory MCP server backed by `.ai/memory`.",
            confidence: 0.62,
          },
        },
      ],
      claims: [
        {
          subjectId: "obj_svc",
          objectId: "obj_inu",
          predicate: "HAS_INSTRUCTION",
          aggregatedConfidence: 0.62,
          validFrom: null,
          validTo: null,
          evidenceKey: "evd:repo_app:README.md",
        },
      ],
      existingKnowledge: [],
      linkedUrls: [],
      workspaceRepositoryUrl: "https://github.com/acme/docs",
      repositoryGitUrlById: new Map([
        ["repo_app", "https://github.com/acme/app.git"],
      ]),
    })
    const service = planned.files.find(
      (file) => file.path === "knowledge/services/billing.md",
    )
    const instruction = planned.files.find(
      (file) =>
        file.path === "knowledge/instructions/local-memory-initialization.md",
    )
    expect(service?.content).toContain("claims:")
    expect(service?.content).toContain("predicate: HAS_INSTRUCTION")
    expect(service?.content).toContain("confidence: 0.62")
    expect(service?.content).toContain(
      "](../instructions/local-memory-initialization.md)",
    )
    expect(service?.content).toContain(
      "source: \"https://github.com/acme/app.git#README.md\"",
    )
    expect(service?.content).not.toContain("evd:repo_app")
    expect(instruction?.content).toContain("kind: InstructionUnit")
    expect(instruction?.content).toContain("confidence: 0.62")
    expect(instruction?.content).toContain("generated_by: ctxpipe")
    expect(instruction?.content).toContain(
      "Intent: enable local context storage without a hosted account",
    )
    expect(instruction?.content).toContain("Source: `README.md`")
    expect(instruction?.content).toContain(
      "> Add a ctxpipe-memory MCP server backed by `.ai/memory`.",
    )
    expect(instruction?.content).not.toMatch(/^claims:/m)
  })

  it("rewrites a thin import_key file and no-ops a content-complete one", async () => {
    const thin = `---
import_key: svc:repo_app:./
---

# Billing

Ledger lives here.
`
    const thinPlan = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          kind: "Service",
          deduplicationKey: "svc:repo_app:./",
          payload: { name: "Billing", summary: "Ledger lives here." },
        },
      ],
      claims: [],
      existingKnowledge: [
        { path: "knowledge/payments/billing.md", content: thin },
      ],
      linkedUrls: [],
    })
    expect(thinPlan.files[0]?.path).toBe("knowledge/payments/billing.md")
    expect(thinPlan.wouldChange).toBe(true)
    expect(thinPlan.files[0]?.content).toContain("kind: Service")
    expect(thinPlan.files[0]?.content).toContain("generated_by: ctxpipe")

    const existing = importedObjectMarkdown({
      title: "Billing",
      body: "Ledger lives here.",
      importKey: "svc:repo_app:./",
      kind: "Service",
    })
    const planned = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          kind: "Service",
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

  it("leaves an existing import_key under knowledge/imported in place", async () => {
    const existing = importedObjectMarkdown({
      title: "Billing",
      body: "Ledger lives here.",
      importKey: "svc:repo_app:./",
      kind: "Service",
    })
    const planned = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          kind: "Service",
          deduplicationKey: "svc:repo_app:./",
          payload: { name: "Billing", summary: "Ledger lives here." },
        },
      ],
      claims: [],
      existingKnowledge: [
        { path: "knowledge/imported/billing.md", content: existing },
      ],
      linkedUrls: [],
    })
    expect(planned.files[0]?.path).toBe("knowledge/imported/billing.md")
    expect(planned.wouldChange).toBe(false)
  })

  it("appends into an unkeyed occupant instead of replacing it", async () => {
    const planned = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          kind: "Service",
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
          path: "knowledge/services/billing.md",
          content: "# Billing\n\nLedger lives here.",
        },
      ],
      linkedUrls: [],
      classifyUnkeyed: async () => "merge",
    })
    expect(planned.files[0]?.path).toBe("knowledge/services/billing.md")
    expect(planned.files[0]?.content).toContain("Ledger lives here.")
    expect(planned.files[0]?.content).toContain("Also the ledger.")
    expect(planned.files[0]?.content).toContain("import_key: svc:repo_app:./")
  })

  it("uses a new filename when the unkeyed classifier returns new_name", async () => {
    const planned = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          kind: "Service",
          deduplicationKey: "svc:repo_app:./",
          payload: { name: "Billing", summary: "Invoices" },
        },
      ],
      claims: [],
      existingKnowledge: [
        {
          path: "knowledge/services/billing.md",
          content: "Ledger lives here.",
        },
      ],
      linkedUrls: [],
      classifyUnkeyed: async () => "new_name",
    })
    expect(planned.files[0]?.path).toBe("knowledge/services/billing-2.md")
    expect(planned.files[0]?.content).toContain("Invoices")
    expect(
      planned.files.some(
        (file) => file.path === "knowledge/services/billing.md",
      ),
    ).toBe(false)
  })

  it("claims an unkeyed occupant after the first merge", async () => {
    const planned = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          kind: "Service",
          deduplicationKey: "svc:repo_app:a",
          payload: { name: "Billing", summary: "First" },
        },
        {
          id: "obj_2",
          kind: "Service",
          deduplicationKey: "svc:repo_app:b",
          payload: { name: "Billing", summary: "Second" },
        },
      ],
      claims: [],
      existingKnowledge: [
        {
          path: "knowledge/services/billing.md",
          content: "Ledger lives here.",
        },
      ],
      linkedUrls: [],
      classifyUnkeyed: async () => "merge",
    })
    expect(planned.files.map((file) => file.path).sort()).toEqual([
      "knowledge/services/billing-2.md",
      "knowledge/services/billing.md",
    ])
  })

  it("writes a workspace-relative source for in-tree connector paths", async () => {
    const planned = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_ws", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          kind: "Service",
          deduplicationKey: "svc:repo_ws:./",
          payload: {
            name: "Billing",
            summary: "Ledger lives here.",
            path: "linear/issues/PAY-12.md",
          },
        },
      ],
      claims: [],
      existingKnowledge: [
        {
          path: "linear/issues/PAY-12.md",
          content: "Pay twelve",
        },
      ],
      linkedUrls: [],
      workspaceRepositoryUrl: "https://github.com/acme/docs.git",
      repositoryGitUrlById: new Map([
        ["repo_ws", "https://github.com/acme/docs"],
      ]),
    })
    expect(planned.files[0]?.content).toContain(
      "source: ../../linear/issues/PAY-12.md",
    )
    expect(planned.files[0]?.content).not.toContain("evd:")
  })

  it("omits import_key after a recorded export and does not restamp it", async () => {
    const existing = importedObjectMarkdown({
      title: "Billing",
      body: "Ledger lives here.",
      importKey: "svc:repo_app:./",
      kind: "Service",
    })
    const planned = await planMigrationExport({
      workspaceId: "ws_app",
      firstWorkspaceId: "ws_app",
      workspaceByRepositoryId: new Map([["repo_app", "ws_app"]]),
      objects: [
        {
          id: "obj_1",
          kind: "Service",
          deduplicationKey: "svc:repo_app:./",
          payload: { name: "Billing", summary: "Ledger lives here." },
        },
      ],
      claims: [],
      existingKnowledge: [
        { path: "knowledge/services/billing.md", content: existing },
      ],
      linkedUrls: [],
      stampImportKey: false,
    })
    expect(planned.files[0]?.path).toBe("knowledge/services/billing.md")
    expect(planned.files[0]?.content).not.toContain("import_key:")
    expect(planned.files[0]?.content).toContain("kind: Service")
    expect(planned.wouldChange).toBe(true)
  })
})
