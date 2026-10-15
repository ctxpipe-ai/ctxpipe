import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import {
  completedNoOpExportSha,
  importedObjectMarkdown,
  importKeyForExportedObject,
  importKeyFromDedup,
  isoDate,
  migrationLinkedRepositoryUrls,
  migrationSourcesFile,
  noOpExportUsesResolvedTip,
  objectTitleFromPayload,
  planKnowledgeProjection,
  repositoryIdFromDedup,
  upgradeLinkedRepositories,
  workspaceByRepositoryUrl,
} from "./migration-export.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

const urls = (gitUrls: string[]) =>
  gitUrls.map((gitUrl) => ({ gitUrl, ref: null }))

describe("migration export", () => {
  it("links the other org repositories only in the first Workspace", () => {
    const repositories = [
      { id: "repo_app", gitUrl: "https://github.com/acme/app.git" },
      { id: "repo_api", gitUrl: "git@github.com:Acme/API.git" },
      { id: "repo_docs", gitUrl: "https://github.com/acme/docs" },
    ]
    const workspaceByRepositoryId = new Map([
      ["repo_app", "ws_app"],
      ["repo_docs", "ws_docs"],
    ])
    expect(
      migrationLinkedRepositoryUrls({
        workspaceId: "ws_app",
        firstWorkspaceId: "ws_app",
        repositories,
        workspaceByRepositoryId,
      }),
    ).toEqual(["git@github.com:Acme/API.git"])
    expect(
      migrationLinkedRepositoryUrls({
        workspaceId: "ws_docs",
        firstWorkspaceId: "ws_app",
        repositories,
        workspaceByRepositoryId,
      }),
    ).toEqual([])
  })

  it("writes the linked repositories as one GitHub source of sources.yaml", () => {
    const text = migrationSourcesFile({
      sourcesFile: null,
      connectionId: "con_gh",
      repositories: urls([
        "git@github.com:Acme/API.git",
        "https://github.com/acme/web",
        "https://gitlab.com/acme/tools",
      ]),
    })
    expect(parse(text ?? "")).toEqual({
      version: 1,
      sources: [
        {
          id: "linked-repositories",
          provider: "github",
          connection: "con_gh",
          repositories: ["acme/api", "acme/web"],
        },
      ],
    })
    // A second run changes nothing.
    expect(
      migrationSourcesFile({
        sourcesFile: text,
        connectionId: "con_gh",
        repositories: urls([
          "https://github.com/acme/api",
          "https://github.com/acme/web",
        ]),
      }),
    ).toBeNull()
  })

  it("moves the files into sources.yaml and keeps the ref of a link without one", () => {
    const declaration = (git: string, branch?: string) =>
      `---\ngit: ${git}\n${branch ? `branch: ${branch}\n` : ""}---\n`
    const result = upgradeLinkedRepositories({
      sourcesFile:
        "version: 1\nsources:\n  - id: code\n    provider: github\n    connection: con_gh\n    repositories: [acme/web, {name: acme/jobs, ref: main}]\n",
      connectionId: "con_gh",
      files: [
        // Linked without a ref: the link gets the branch of the file.
        {
          path: "repositories/web.md",
          content: declaration("https://github.com/acme/web", "stable"),
        },
        // Linked with another ref: the file stays.
        {
          path: "repositories/jobs.md",
          content: declaration("https://github.com/acme/jobs", "dev"),
        },
        {
          path: "repositories/api.md",
          content: declaration("https://github.com/acme/api"),
        },
        {
          path: "repositories/tools.md",
          content: declaration("https://gitlab.com/acme/tools"),
        },
        { path: "repositories/bad.md", content: "---\nname: no git\n" },
      ],
      repositories: [
        { gitUrl: "https://github.com/acme/ops" },
        { gitUrl: "https://bitbucket.org/acme/legacy" },
      ],
    })
    expect(parse(result.sourcesFile ?? "").sources[0].repositories).toEqual([
      { name: "acme/web", ref: "stable" },
      { name: "acme/jobs", ref: "main" },
      "acme/api",
      "acme/ops",
    ])
    expect(result.deletePaths).toEqual([
      "repositories/web.md",
      "repositories/api.md",
    ])
    expect(result.skipped).toEqual([
      {
        item: "repositories/jobs.md",
        reason: expect.stringContaining("ref main"),
      },
      {
        item: "repositories/tools.md",
        reason: expect.stringContaining("only GitHub"),
      },
      {
        item: "repositories/bad.md",
        reason: expect.stringContaining("cannot be read"),
      },
      {
        item: "https://bitbucket.org/acme/legacy",
        reason: expect.stringContaining("only GitHub"),
      },
    ])
    // Running it again on its own result changes nothing.
    expect(
      upgradeLinkedRepositories({
        sourcesFile: result.sourcesFile,
        connectionId: "con_gh",
        files: [],
        repositories: [{ gitUrl: "https://github.com/acme/ops" }],
      }),
    ).toEqual({ sourcesFile: null, deletePaths: [], skipped: [] })
  })

  it("adds only the repositories that no GitHub source of the file links", () => {
    const text = migrationSourcesFile({
      sourcesFile:
        "# Owned by the team\nversion: 1\nsources:\n  - id: code\n    provider: github\n    connection: con_gh\n    repositories: [acme/web]\n",
      connectionId: "con_gh",
      repositories: urls([
        "https://github.com/acme/web",
        "https://github.com/acme/api",
      ]),
    })
    expect(text).toContain("# Owned by the team")
    // The GitHub source of the same connection gets the new repository.
    expect(parse(text ?? "").sources).toEqual([
      {
        id: "code",
        provider: "github",
        connection: "con_gh",
        repositories: ["acme/web", "acme/api"],
      },
    ])
    const grown = migrationSourcesFile({
      sourcesFile: text,
      connectionId: "con_gh",
      repositories: urls(["https://github.com/acme/jobs"]),
    })
    expect(parse(grown ?? "").sources[0].repositories).toEqual([
      "acme/web",
      "acme/api",
      "acme/jobs",
    ])
    expect(
      migrationSourcesFile({
        sourcesFile: "version: 2\n",
        connectionId: "con_gh",
        repositories: urls(["https://github.com/acme/api"]),
      }),
    ).toBeNull()
    expect(
      migrationSourcesFile({
        sourcesFile: null,
        connectionId: "con_gh",
        repositories: urls(["https://gitlab.com/acme/tools"]),
      }),
    ).toBeNull()
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
    const planned = await planKnowledgeProjection({
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
    })
    expect(planned.wouldChange).toBe(true)
    expect(planned.files.map((file) => file.path)).toEqual([
      "knowledge/services/billing.md",
    ])
    expect(planned.files[0]?.content).toContain("import_key: svc:repo_app:./")
    expect(planned.files[0]?.content).toContain("kind: Service")
    expect(planned.files[0]?.content).toContain("generated_by: ctxpipe")
    expect(planned.files[0]?.content).not.toContain("DEPENDS_ON")
    expect(planned.files[0]?.content).not.toContain("obj_")
  })

  it("serializes a same-workspace claim with confidence and a body link", async () => {
    const planned = await planKnowledgeProjection({
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
            sourceExcerpt:
              "Add a ctxpipe-memory MCP server backed by `.ai/memory`.",
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
      'source: "https://github.com/acme/app.git#README.md"',
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
    const thinPlan = await planKnowledgeProjection({
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
    const planned = await planKnowledgeProjection({
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
    const planned = await planKnowledgeProjection({
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
    })
    expect(planned.files[0]?.path).toBe("knowledge/imported/billing.md")
    expect(planned.wouldChange).toBe(false)
  })

  it("does not route an import_key match into a host-only path", async () => {
    const existing = importedObjectMarkdown({
      title: "Billing",
      body: "Ledger lives here.",
      importKey: "svc:repo_app:./",
      kind: "Service",
    })
    const planned = await planKnowledgeProjection({
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
      existingKnowledge: [{ path: ".ctxpipe/billing.md", content: existing }],
      linkedUrls: [],
    })
    expect(planned.files.map((file) => file.path)).not.toContain(
      ".ctxpipe/billing.md",
    )
    expect(planned.files[0]?.path).toMatch(/^knowledge\//)
  })

  it("appends into an unkeyed occupant instead of replacing it", async () => {
    const planned = await planKnowledgeProjection({
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
      classifyUnkeyed: async () => "merge",
    })
    expect(planned.files[0]?.path).toBe("knowledge/services/billing.md")
    expect(planned.files[0]?.content).toContain("Ledger lives here.")
    expect(planned.files[0]?.content).toContain("Also the ledger.")
    expect(planned.files[0]?.content).toContain("import_key: svc:repo_app:./")
  })

  it("uses a new filename when the unkeyed classifier returns new_name", async () => {
    const planned = await planKnowledgeProjection({
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
    const planned = await planKnowledgeProjection({
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
      classifyUnkeyed: async () => "merge",
    })
    expect(planned.files.map((file) => file.path).sort()).toEqual([
      "knowledge/services/billing-2.md",
      "knowledge/services/billing.md",
    ])
  })

  it("writes a workspace-relative source for in-tree connector paths", async () => {
    const planned = await planKnowledgeProjection({
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
    const planned = await planKnowledgeProjection({
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
      stampImportKey: false,
    })
    expect(planned.files[0]?.path).toBe("knowledge/services/billing.md")
    expect(planned.files[0]?.content).not.toContain("import_key:")
    expect(planned.files[0]?.content).toContain("kind: Service")
    expect(planned.wouldChange).toBe(true)
  })
})
