import { describe, expect, it } from "vitest"
import {
  assignImportedRepository,
  classifyUnkeyedKnowledgeCollision,
  firstConnectorTarget,
  mergeImportedClaims,
  nextKnowledgeUnitPath,
  parseUnkeyedCollisionReply,
  shouldExportClaim,
  unkeyedCollisionExcerpt,
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

describe("classifyUnkeyedKnowledgeCollision", () => {
  it("parses merge vs new_name and treats garbage as new_name", () => {
    expect(parseUnkeyedCollisionReply("merge")).toBe("merge")
    expect(parseUnkeyedCollisionReply("NEW_NAME")).toBe("new_name")
    expect(parseUnkeyedCollisionReply("sure, merge them")).toBe("garbage")
    expect(unkeyedCollisionExcerpt("x".repeat(500)).length).toBe(400)
  })

  it("always asks the classifier, including identical excerpts", async () => {
    expect(
      await classifyUnkeyedKnowledgeCollision({
        existingPath: "knowledge/imported/billing.md",
        incomingPath: "knowledge/imported/billing.md",
        existingExcerpt: "Ledger",
        incomingExcerpt: "Ledger",
        classify: async () => "merge",
      }),
    ).toBe("merge")
    expect(
      await classifyUnkeyedKnowledgeCollision({
        existingPath: "knowledge/imported/billing.md",
        incomingPath: "knowledge/imported/billing.md",
        existingExcerpt: "Ledger",
        incomingExcerpt: "Ledger",
        classify: async () => {
          throw new Error("should fail closed")
        },
      }),
    ).toBe("new_name")
  })

  it("uses the fast-model reply and fails closed to new_name", async () => {
    expect(
      await classifyUnkeyedKnowledgeCollision({
        existingPath: "knowledge/imported/billing.md",
        incomingPath: "knowledge/imported/billing.md",
        existingExcerpt: "Ledger",
        incomingExcerpt: "Invoices",
        classify: async () => "merge",
      }),
    ).toBe("merge")
    expect(
      await classifyUnkeyedKnowledgeCollision({
        existingPath: "knowledge/imported/billing.md",
        incomingPath: "knowledge/imported/billing.md",
        existingExcerpt: "Ledger",
        incomingExcerpt: "Invoices",
        classify: async () => "wat",
      }),
    ).toBe("new_name")
    expect(
      await classifyUnkeyedKnowledgeCollision({
        existingPath: "knowledge/imported/billing.md",
        incomingPath: "knowledge/imported/billing.md",
        existingExcerpt: "Ledger",
        incomingExcerpt: "Invoices",
        classify: async () => {
          throw new Error("timeout")
        },
      }),
    ).toBe("new_name")
    expect(
      await classifyUnkeyedKnowledgeCollision({
        existingPath: "knowledge/imported/billing.md",
        incomingPath: "knowledge/imported/billing.md",
        existingExcerpt: "Ledger",
        incomingExcerpt: "Invoices",
        timeoutMs: 20,
        classify: () => new Promise(() => undefined),
      }),
    ).toBe("new_name")
  })
})

describe("nextKnowledgeUnitPath", () => {
  it("writes knowledge/<area>/<unit>.md and increments on collision", () => {
    expect(nextKnowledgeUnitPath("services", "billing", [])).toBe(
      "knowledge/services/billing.md",
    )
    expect(
      nextKnowledgeUnitPath("services", "billing", [
        "knowledge/services/billing.md",
        "knowledge/services/billing-2.md",
      ]),
    ).toBe("knowledge/services/billing-3.md")
    expect(nextKnowledgeUnitPath("codebases", "docs", [])).toBe(
      "knowledge/codebases/docs.md",
    )
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

  it("keeps existing temporality unless incoming supplies a value", () => {
    expect(
      mergeImportedClaims(
        [
          {
            to: "svc",
            predicate: "owns",
            confidence: 0.4,
            validFrom: "2026-01-01",
            validTo: "2026-06-01",
            source: "git",
          },
        ],
        [
          {
            to: "svc",
            predicate: "owns",
            confidence: 0.9,
            validFrom: null,
            validTo: null,
            source: null,
          },
        ],
      ),
    ).toEqual([
      {
        to: "svc",
        predicate: "owns",
        confidence: 0.9,
        validFrom: "2026-01-01",
        validTo: "2026-06-01",
        source: "git",
      },
    ])
  })
})
