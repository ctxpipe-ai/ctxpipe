import { describe, expect, it } from "vitest"
import {
  deletePathsForWorkspaceWriteKind,
  filesForWorkspaceWriteKind,
  postExportFollowUpKinds,
  shouldEnqueueBootstrapAfterExport,
  shouldEnqueueImportKeyCleanupAfterExport,
} from "./write-commit-files.js"

describe("filesForWorkspaceWriteKind", () => {
  it("writes only allowlisted bootstrap files", () => {
    const files = filesForWorkspaceWriteKind({
      kind: "bootstrap",
      displayName: "Docs",
      linkedUrls: ["https://github.com/acme/app"],
      existing: new Map(),
    })
    expect(files.map((file) => file.path)).toEqual([
      "AGENTS.md",
      ".agents/skills/ctxpipe-knowledge/SKILL.md",
    ])
    expect(files.some((file) => file.path.startsWith("knowledge/"))).toBe(false)
  })

  it("writes and deletes repositories/*.md for link_unlink", () => {
    const files = filesForWorkspaceWriteKind({
      kind: "link_unlink",
      displayName: "Docs",
      linkedUrls: ["https://github.com/acme/app"],
      existing: new Map(),
      linkChange: {
        action: "link",
        gitUrl: "https://github.com/acme/billing.git",
      },
    })
    expect(files.map((file) => file.path)).toEqual([
      "repositories/app.md",
      "repositories/billing.md",
    ])
    expect(
      filesForWorkspaceWriteKind({
        kind: "link_unlink",
        displayName: "Docs",
        linkedUrls: [
          "https://github.com/acme/app",
          "https://github.com/acme/billing.git",
        ],
        existing: new Map(),
        linkChange: {
          action: "unlink",
          gitUrl: "https://github.com/acme/billing.git",
        },
      }).map((file) => file.path),
    ).toEqual(["repositories/app.md"])
    expect(
      deletePathsForWorkspaceWriteKind({
        kind: "link_unlink",
        linkedUrls: [
          "https://github.com/acme/app",
          "https://github.com/acme/billing.git",
        ],
        linkChange: {
          action: "unlink",
          gitUrl: "https://github.com/acme/billing.git",
        },
      }),
    ).toEqual(["repositories/billing.md"])
  })

  it("upgrades markdown links for claims_upgrade", () => {
    const files = filesForWorkspaceWriteKind({
      kind: "claims_upgrade",
      displayName: "Docs",
      linkedUrls: [],
      workspaceId: "ws_1",
      existing: new Map([
        [
          "knowledge/a.md",
          "---\nname: A\n---\n\nSee [ledger](../billing/ledger.md).\n",
        ],
      ]),
    })
    expect(files).toHaveLength(1)
    expect(files[0]?.content).toContain("to: ../billing/ledger.md")
  })

  it("uses the export plan for migration_export", () => {
    const files = filesForWorkspaceWriteKind({
      kind: "migration_export",
      displayName: "Docs",
      linkedUrls: [],
      existing: new Map(),
      exportPlan: {
        files: [{ path: "knowledge/services/billing.md", content: "x\n" }],
        wouldChange: true,
      },
    })
    expect(files).toEqual([
      { path: "knowledge/services/billing.md", content: "x\n" },
    ])
    expect(
      filesForWorkspaceWriteKind({
        kind: "extract_ingest",
        displayName: "Docs",
        linkedUrls: [],
        existing: new Map(),
        exportPlan: {
          files: [
            { path: "knowledge/services/billing.md", content: "x\n" },
            { path: "repositories/app.md", content: "---\ngit: x\n---\n" },
          ],
          wouldChange: true,
        },
      }),
    ).toEqual([{ path: "knowledge/services/billing.md", content: "x\n" }])
  })

  it("replays captured job files onto the remote tip for semantic merge", () => {
    expect(
      filesForWorkspaceWriteKind({
        kind: "semantic_merge",
        displayName: "Docs",
        linkedUrls: [],
        existing: new Map([["knowledge/a.md", "old"]]),
        mergeFiles: [{ path: "knowledge/a.md", content: "merged" }],
      }),
    ).toEqual([{ path: "knowledge/a.md", content: "merged" }])
    expect(
      deletePathsForWorkspaceWriteKind({
        kind: "semantic_merge",
        linkedUrls: [],
        mergeDeletePaths: ["knowledge/gone.md"],
      }),
    ).toEqual(["knowledge/gone.md"])
  })

  it("replays Files pane writes for ui_file_edit", () => {
    expect(
      filesForWorkspaceWriteKind({
        kind: "ui_file_edit",
        displayName: "Docs",
        linkedUrls: [],
        existing: new Map(),
        mergeFiles: [{ path: "AGENTS.md", content: "edited" }],
      }),
    ).toEqual([{ path: "AGENTS.md", content: "edited" }])
    expect(
      deletePathsForWorkspaceWriteKind({
        kind: "ui_file_edit",
        linkedUrls: [],
        mergeDeletePaths: ["scratch.md"],
      }),
    ).toEqual(["scratch.md"])
  })
})

describe("shouldEnqueueBootstrapAfterExport", () => {
  it("strips import_key from knowledge files", () => {
    const files = filesForWorkspaceWriteKind({
      kind: "import_key_cleanup",
      displayName: "Docs",
      linkedUrls: [],
      existing: new Map([
        [
          "knowledge/services/billing.md",
          "---\nimport_key: svc:repo_app:./\nkind: Service\nclaims:\n  - to: ../payments/api.md\n    predicate: DEPENDS_ON\n    confidence: 0.7\n---\n\n# Billing\n\nLedger lives here.\n",
        ],
        ["AGENTS.md", "---\nname: Docs\n---\n"],
      ]),
    })
    expect(files).toHaveLength(1)
    expect(files[0]?.content).not.toContain("import_key:")
    expect(files[0]?.content).toContain("kind: Service")
    expect(files[0]?.content).toContain("predicate: DEPENDS_ON")
    expect(files[0]?.content).toContain("Ledger lives here.")
    expect(
      filesForWorkspaceWriteKind({
        kind: "import_key_cleanup",
        displayName: "Docs",
        linkedUrls: [],
        existing: new Map([
          [
            "knowledge/services/billing.md",
            "---\nkind: Service\n---\n\n# Billing\n",
          ],
        ]),
      }),
    ).toEqual([])
  })

  it("enqueues bootstrap after a real or no-op export, not after bootstrap itself", () => {
    expect(
      shouldEnqueueBootstrapAfterExport({
        kind: "migration_export",
        committed: true,
        noOpExport: false,
      }),
    ).toBe(true)
    expect(
      shouldEnqueueBootstrapAfterExport({
        kind: "migration_export",
        committed: false,
        noOpExport: true,
      }),
    ).toBe(true)
    expect(
      shouldEnqueueBootstrapAfterExport({
        kind: "bootstrap",
        committed: true,
        noOpExport: false,
      }),
    ).toBe(false)
    expect(
      shouldEnqueueImportKeyCleanupAfterExport({
        kind: "migration_export",
        committed: true,
        noOpExport: false,
      }),
    ).toBe(true)
    expect(
      postExportFollowUpKinds({
        kind: "migration_export",
        committed: true,
        noOpExport: false,
      }),
    ).toEqual(["bootstrap", "import_key_cleanup"])
  })
})
