import { describe, expect, it } from "vitest"
import {
  filesForWorkspaceWriteKind,
  shouldEnqueueBootstrapAfterExport,
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

  it("uses the export plan for migration_export", () => {
    const files = filesForWorkspaceWriteKind({
      kind: "migration_export",
      displayName: "Docs",
      linkedUrls: [],
      existing: new Map(),
      exportPlan: {
        files: [{ path: "knowledge/imported/billing.md", content: "x\n" }],
        wouldChange: true,
      },
    })
    expect(files).toEqual([
      { path: "knowledge/imported/billing.md", content: "x\n" },
    ])
  })
})

describe("shouldEnqueueBootstrapAfterExport", () => {
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
  })
})
