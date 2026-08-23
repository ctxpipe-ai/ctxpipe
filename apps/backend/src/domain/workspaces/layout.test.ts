import { describe, expect, it } from "vitest"
import {
  greenfieldKnowledgePath,
  isImportedKnowledgePath,
  isLinkedRepositoryDeclaration,
  knowledgeAreaFromObjectKind,
  parseLinkedRepositoryMarkdown,
  parseSimpleFrontMatter,
} from "./layout.js"

describe("knowledge layout", () => {
  it("prefers knowledge/<area>/<unit>.md on a greenfield tree", () => {
    expect(greenfieldKnowledgePath("Payments API", "Ledger")).toBe(
      "knowledge/payments-api/ledger.md",
    )
  })

  it("maps object kinds to knowledge area folders", () => {
    expect(knowledgeAreaFromObjectKind("Service")).toBe("services")
    expect(knowledgeAreaFromObjectKind("API")).toBe("apis")
    expect(knowledgeAreaFromObjectKind("Repository")).toBe("codebases")
    expect(knowledgeAreaFromObjectKind("InstructionUnit")).toBe("instructions")
    expect(knowledgeAreaFromObjectKind("")).toBe("topics")
    expect(knowledgeAreaFromObjectKind("CustomKind")).toBe("customkind")
    expect(isImportedKnowledgePath("knowledge/imported/billing.md")).toBe(true)
    expect(isImportedKnowledgePath("knowledge/services/billing.md")).toBe(false)
  })

  it("keeps repositories/*.md flat", () => {
    expect(isLinkedRepositoryDeclaration("repositories/billing.md")).toBe(true)
    expect(
      isLinkedRepositoryDeclaration("repositories/nested/billing.md"),
    ).toBe(false)
  })

  it("requires git on a linked-repository file and skips malformed fences", () => {
    expect(
      parseLinkedRepositoryMarkdown(
        "---\ngit: https://github.com/acme/billing.git\nbranch: develop\n---\n",
      ),
    ).toEqual({
      git: "https://github.com/acme/billing.git",
      branch: "develop",
      malformed: false,
    })
    expect(parseLinkedRepositoryMarkdown("---\nname: no git\n").malformed).toBe(
      true,
    )
  })

  it("parses optional claims without requiring keys", () => {
    const parsed = parseSimpleFrontMatter(
      "---\nclaims:\n  - to: ../billing/ledger.md\n    predicate: DEPENDS_ON\n    confidence: 0.7\n---\nBody\n",
    )
    expect(parsed.malformed).toBe(false)
    expect(parsed.body.trim()).toBe("Body")
    expect(parsed.attributes.claims).toEqual([
      {
        to: "../billing/ledger.md",
        predicate: "DEPENDS_ON",
        confidence: 0.7,
      },
    ])
  })
})
