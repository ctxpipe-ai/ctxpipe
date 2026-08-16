import { describe, expect, it } from "vitest"
import {
  assignImportedRepository,
  classifyUnkeyedKnowledgeCollision,
  firstConnectorTarget,
  firstWorkspaceIdForCutover,
  mergeImportedClaims,
  nextImportedKnowledgePath,
  planVersionStartCutover,
  shouldExportClaim,
  workspacesNeedingMigrationExport,
  workspacesToCreateForConnectorTargets,
} from "./migration-cutover.js"

describe("firstConnectorTarget", () => {
  it("picks created_at then id", () => {
    const later = {
      id: "repo_a",
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    }
    const earlier = {
      id: "repo_z",
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
    }
    const sameTimeNewerId = {
      id: "repo_b",
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
    }
    expect(firstConnectorTarget([later, earlier, sameTimeNewerId])?.id).toBe(
      "repo_b",
    )
    expect(firstConnectorTarget([])).toBeNull()
  })
})

describe("assignImportedRepository", () => {
  const workspaceByRepositoryId = new Map([
    ["repo_docs", "ws_docs"],
    ["repo_app", "ws_app"],
  ])

  it("assigns a workspace-repository row to that Workspace", () => {
    expect(
      assignImportedRepository({
        repositoryId: "repo_app",
        workspaceByRepositoryId,
        firstWorkspaceId: "ws_docs",
      }),
    ).toEqual({ workspaceId: "ws_app" })
  })

  it("sends linked or unkeyed rows to the first Workspace", () => {
    expect(
      assignImportedRepository({
        repositoryId: "repo_other",
        workspaceByRepositoryId,
        firstWorkspaceId: "ws_docs",
      }),
    ).toEqual({ workspaceId: "ws_docs" })
    expect(
      assignImportedRepository({
        repositoryId: null,
        workspaceByRepositoryId,
        firstWorkspaceId: "ws_docs",
      }),
    ).toEqual({ workspaceId: "ws_docs" })
  })

  it("skips when the org has no Workspace yet", () => {
    expect(
      assignImportedRepository({
        repositoryId: "repo_other",
        workspaceByRepositoryId: new Map(),
        firstWorkspaceId: null,
      }),
    ).toEqual({ skip: "no_workspace" })
  })
})

describe("shouldExportClaim", () => {
  it("skips a claim whose other end is in another Workspace", () => {
    expect(
      shouldExportClaim({
        fromWorkspaceId: "ws_a",
        toWorkspaceId: "ws_b",
      }),
    ).toBe(false)
    expect(
      shouldExportClaim({
        fromWorkspaceId: "ws_a",
        toWorkspaceId: "ws_a",
      }),
    ).toBe(true)
  })
})

describe("workspacesToCreateForConnectorTargets", () => {
  it("creates one Workspace per unseen connector-target URL", () => {
    expect(
      workspacesToCreateForConnectorTargets({
        repositories: [
          { gitUrl: "https://github.com/acme/docs.git" },
          { gitUrl: "https://github.com/acme/app" },
          { gitUrl: "https://github.com/acme/docs" },
        ],
        existingWorkspaceUrls: ["https://github.com/acme/docs"],
        normalizeUrl: (url) => url.replace(/\.git$/i, ""),
      }),
    ).toEqual(["https://github.com/acme/app"])
  })
})

describe("planVersionStartCutover", () => {
  const normalizeUrl = (url: string) => url.replace(/\.git$/i, "")

  it("creates missing connector-target Workspaces and persists first before export", () => {
    expect(
      planVersionStartCutover({
        connectorTargets: [
          { gitUrl: "https://github.com/acme/docs.git" },
          { gitUrl: "https://github.com/acme/app" },
        ],
        existingWorkspaceUrls: [],
        persistedFirstWorkspaceId: null,
        normalizeUrl,
      }),
    ).toEqual({
      urlsToCreate: [
        "https://github.com/acme/docs",
        "https://github.com/acme/app",
      ],
      persistFirst: true,
      enqueueExports: true,
    })
  })

  it("does not recompute first when it is already persisted", () => {
    expect(
      planVersionStartCutover({
        connectorTargets: [{ gitUrl: "https://github.com/acme/new" }],
        existingWorkspaceUrls: ["https://github.com/acme/docs"],
        persistedFirstWorkspaceId: "ws_first",
        normalizeUrl,
      }),
    ).toEqual({
      urlsToCreate: ["https://github.com/acme/new"],
      persistFirst: false,
      enqueueExports: true,
    })
  })

  it("enqueues nothing when the org has no connector target", () => {
    expect(
      planVersionStartCutover({
        connectorTargets: [],
        existingWorkspaceUrls: [],
        persistedFirstWorkspaceId: null,
        normalizeUrl,
      }),
    ).toEqual({
      urlsToCreate: [],
      persistFirst: false,
      enqueueExports: false,
    })
  })
})

describe("firstWorkspaceIdForCutover", () => {
  it("keeps the persisted first Workspace even when a newer row sorts first", () => {
    expect(
      firstWorkspaceIdForCutover({
        persistedFirstWorkspaceId: "ws_first",
        currentWorkspaceIds: ["ws_newer", "ws_first"],
        computedFirstWorkspaceId: "ws_newer",
      }),
    ).toBe("ws_first")
  })

  it("does not recompute when no first Workspace is persisted", () => {
    expect(
      firstWorkspaceIdForCutover({
        persistedFirstWorkspaceId: null,
        currentWorkspaceIds: ["ws_newer"],
        computedFirstWorkspaceId: "ws_newer",
      }),
    ).toBeNull()
  })
})

describe("workspacesNeedingMigrationExport", () => {
  it("skips Workspaces whose export commit is already recorded", () => {
    expect(
      workspacesNeedingMigrationExport({
        workspaces: [{ id: "ws_done" }, { id: "ws_pending" }],
        completedExportWorkspaceIds: ["ws_done"],
      }),
    ).toEqual(["ws_pending"])
  })
})

describe("classifyUnkeyedKnowledgeCollision", () => {
  it("merges the same fact and renames a heading collision", () => {
    expect(
      classifyUnkeyedKnowledgeCollision({
        existingBody: "# Billing\n\nLedger.",
        incomingBody: "# Billing\n\nAlso the ledger.",
      }),
    ).toBe("merge")
    expect(
      classifyUnkeyedKnowledgeCollision({
        existingBody: "Billing",
        incomingBody: "Also billing",
      }),
    ).toBe("new_name")
  })
})

describe("nextImportedKnowledgePath", () => {
  it("writes knowledge/imported and increments on collision", () => {
    expect(nextImportedKnowledgePath("billing", [])).toBe(
      "knowledge/imported/billing.md",
    )
    expect(
      nextImportedKnowledgePath("billing", [
        "knowledge/imported/billing.md",
        "knowledge/imported/billing-2.md",
      ]),
    ).toBe("knowledge/imported/billing-3.md")
  })
})

describe("mergeImportedClaims", () => {
  it("unions on (to, predicate) and keeps the higher confidence", () => {
    expect(
      mergeImportedClaims(
        [{ to: "svc", predicate: "owns", confidence: 0.4, body: "old" }],
        [
          { to: "svc", predicate: "owns", confidence: 0.9, body: "new fact" },
          { to: "db", predicate: "uses", confidence: 0.5 },
        ],
      ),
    ).toEqual([
      {
        to: "svc",
        predicate: "owns",
        confidence: 0.9,
        body: "old\n\nnew fact",
      },
      { to: "db", predicate: "uses", confidence: 0.5 },
    ])
  })
})
