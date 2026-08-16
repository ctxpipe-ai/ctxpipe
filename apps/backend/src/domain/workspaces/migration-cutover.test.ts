import { describe, expect, it } from "vitest"
import {
  assignImportedRepository,
  firstConnectorTarget,
  mergeImportedClaims,
  nextImportedKnowledgePath,
  shouldExportClaim,
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
