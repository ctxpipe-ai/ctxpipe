import { describe, expect, it } from "vitest"
import { EXTENSION_TRAVERSAL_PREDICATES } from "../services/graphTraversal.js"
import {
  CORE_ALLOWED_CONNECTIONS,
  EXTENSION_ALLOWED_CONNECTIONS,
  getGraphEdgeTypes,
  getGraphNodeKinds,
  isAllowedConnection,
  isValidGraphEdgeType,
  PREDICATE_DESCRIPTIONS,
} from "./allowedConnections.js"
import { CoreNodeType, CoreRelType } from "./core.js"
import { ExtensionNodeType, ExtensionRelType } from "./extension.js"

describe("ontology consistency (ADR-033)", () => {
  it("every allowed predicate has a planner description and every description names a real predicate", () => {
    const predicates = new Set(getGraphEdgeTypes())
    for (const predicate of predicates) {
      expect(PREDICATE_DESCRIPTIONS[predicate], predicate).toBeTruthy()
    }
    for (const described of Object.keys(PREDICATE_DESCRIPTIONS)) {
      expect(predicates.has(described), described).toBe(true)
    }
  })

  it("allowed connections only use declared kinds and predicates", () => {
    const kinds = new Set<string>([
      ...CoreNodeType.options,
      ...ExtensionNodeType.options,
      "Repository",
    ])
    const rels = new Set<string>([
      ...CoreRelType.options,
      ...ExtensionRelType.options,
    ])
    for (const c of [
      ...CORE_ALLOWED_CONNECTIONS,
      ...EXTENSION_ALLOWED_CONNECTIONS,
    ]) {
      expect(kinds.has(c.subjectKind), c.subjectKind).toBe(true)
      expect(kinds.has(c.objectKind), c.objectKind).toBe(true)
      expect(rels.has(c.predicate), c.predicate).toBe(true)
    }
  })

  it("every declared kind participates in at least one allowed connection", () => {
    const used = new Set(getGraphNodeKinds())
    for (const kind of [
      ...CoreNodeType.options,
      ...ExtensionNodeType.options,
    ]) {
      expect(used.has(kind), kind).toBe(true)
    }
  })

  it("retired predicates and kinds are gone", () => {
    const rels = new Set<string>([
      ...CoreRelType.options,
      ...ExtensionRelType.options,
    ])
    for (const retired of ["ABOUT", "RELATES_TO", "ASSOCIATED_WITH"]) {
      expect(rels.has(retired), retired).toBe(false)
    }
    for (const retired of ["Concept", "Capability", "Topic"]) {
      expect(
        (ExtensionNodeType.options as string[]).includes(retired),
        retired,
      ).toBe(false)
    }
  })

  it("the extension traversal walks only reference, cause and ownership predicates that exist", () => {
    const rels = new Set(getGraphEdgeTypes())
    for (const predicate of EXTENSION_TRAVERSAL_PREDICATES) {
      expect(rels.has(predicate), predicate).toBe(true)
    }
    expect(EXTENSION_TRAVERSAL_PREDICATES).toContain("RESOLVES")
    expect(EXTENSION_TRAVERSAL_PREDICATES).not.toContain("PART_OF")
    expect(EXTENSION_TRAVERSAL_PREDICATES).not.toContain("DECLARED_IN")
  })

  it("accepts package and repository changes from a pull request", () => {
    expect(isValidGraphEdgeType("CHANGED")).toBe(true)
    for (const kind of ["Service", "App", "Library", "Repository"]) {
      expect(isAllowedConnection("PullRequest", "CHANGED", kind)).toBe(true)
    }
  })

  it("a pull request resolves an issue; only that direction is allowed", () => {
    expect(isAllowedConnection("PullRequest", "RESOLVES", "Issue")).toBe(true)
    expect(isAllowedConnection("Issue", "RESOLVES", "PullRequest")).toBe(false)
  })

  it("an issue can sit under a parent issue, depend on, supersede, or reference another issue", () => {
    for (const predicate of [
      "PART_OF",
      "DEPENDS_ON",
      "SUPERSEDES",
      "REFERENCES",
    ]) {
      expect(isAllowedConnection("Issue", predicate, "Issue"), predicate).toBe(
        true,
      )
    }
  })
})

describe("ingestion v2 skill claims (ADR-052 section 6)", () => {
  it("allows each triple that the skills write", () => {
    for (const subject of ["Repository", "Service", "App", "Library"])
      expect(
        isAllowedConnection(subject, "FOLLOWS", "InstructionUnit"),
        subject,
      ).toBe(true)
    expect(isAllowedConnection("Repository", "USES_LIBRARY", "Library")).toBe(
      true,
    )
    for (const predicate of ["READS_FROM", "WRITES_TO", "DEPENDS_ON"])
      expect(isAllowedConnection("App", predicate, "Database"), predicate).toBe(
        true,
      )
    expect(isAllowedConnection("App", "RUNS_ON", "Infrastructure")).toBe(true)
  })

  it("allows a Workflow to mention a package, and a pull request to change a Workflow", () => {
    for (const kind of ["Service", "App", "Library"])
      expect(isAllowedConnection("Workflow", "MENTIONS", kind), kind).toBe(true)
    expect(isAllowedConnection("Workflow", "MENTIONS", "Repository")).toBe(
      false,
    )
    expect(isAllowedConnection("PullRequest", "CHANGED", "Workflow")).toBe(true)
  })
})
