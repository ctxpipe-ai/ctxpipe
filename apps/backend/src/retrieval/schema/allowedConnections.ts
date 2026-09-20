/**
 * Allowed (subjectKind, predicate, objectKind) triples for core graph.
 */
export const CORE_ALLOWED_CONNECTIONS: Array<{
  subjectKind: string
  predicate: string
  objectKind: string
}> = [
  {
    subjectKind: "Service",
    predicate: "IMPLEMENTED_IN",
    objectKind: "Repository",
  },
  {
    subjectKind: "App",
    predicate: "IMPLEMENTED_IN",
    objectKind: "Repository",
  },
  {
    subjectKind: "Library",
    predicate: "IMPLEMENTED_IN",
    objectKind: "Repository",
  },
  { subjectKind: "Service", predicate: "DEPENDS_ON", objectKind: "Database" },
  { subjectKind: "Service", predicate: "DEPENDS_ON", objectKind: "Service" },
  { subjectKind: "Service", predicate: "DEPENDS_ON", objectKind: "Library" },
  { subjectKind: "Service", predicate: "EXPOSES_API", objectKind: "API" },
  { subjectKind: "Service", predicate: "CONSUMES_API", objectKind: "API" },
  {
    subjectKind: "Service",
    predicate: "CONSUMES_API",
    objectKind: "Operation",
  },
  { subjectKind: "API", predicate: "HAS_OPERATION", objectKind: "Operation" },
  { subjectKind: "Service", predicate: "PRODUCES_TO", objectKind: "Stream" },
  { subjectKind: "Service", predicate: "CONSUMES_FROM", objectKind: "Stream" },
  { subjectKind: "Service", predicate: "READS_FROM", objectKind: "Database" },
  { subjectKind: "Service", predicate: "WRITES_TO", objectKind: "Database" },
  { subjectKind: "Service", predicate: "USES_LIBRARY", objectKind: "Library" },
  {
    subjectKind: "Service",
    predicate: "IMPLEMENTS_PATTERN",
    objectKind: "Pattern",
  },
  {
    subjectKind: "Service",
    predicate: "RUNS_ON",
    objectKind: "Infrastructure",
  },
  { subjectKind: "API", predicate: "CONSUMES_API", objectKind: "API" },
  {
    subjectKind: "Repository",
    predicate: "HAS_INSTRUCTION",
    objectKind: "InstructionUnit",
  },
  {
    subjectKind: "Service",
    predicate: "HAS_INSTRUCTION",
    objectKind: "InstructionUnit",
  },
]

const PACKAGE_KINDS = ["Service", "App", "Library"] as const

/**
 * Allowed (subjectKind, predicate, objectKind) for the extension layer,
 * grouped by relation family (ADR-033).
 */
export const EXTENSION_ALLOWED_CONNECTIONS: Array<{
  subjectKind: string
  predicate: string
  objectKind: string
}> = [
  // provenance
  {
    subjectKind: "InstructionUnit",
    predicate: "MEMBER_OF_PRIMARY",
    objectKind: "Skill",
  },
  {
    subjectKind: "InstructionUnit",
    predicate: "DECLARED_IN",
    objectKind: "File",
  },
  { subjectKind: "Decision", predicate: "DECLARED_IN", objectKind: "File" },
  // containment
  { subjectKind: "File", predicate: "PART_OF", objectKind: "Repository" },
  ...PACKAGE_KINDS.map((objectKind) => ({
    subjectKind: "File",
    predicate: "PART_OF",
    objectKind,
  })),
  // change
  {
    subjectKind: "PullRequest",
    predicate: "TARGETS",
    objectKind: "Repository",
  },
  { subjectKind: "PullRequest", predicate: "ADDED", objectKind: "File" },
  { subjectKind: "PullRequest", predicate: "MODIFIED", objectKind: "File" },
  { subjectKind: "PullRequest", predicate: "REMOVED", objectKind: "File" },
  { subjectKind: "PullRequest", predicate: "RENAMED", objectKind: "File" },
  // reference
  { subjectKind: "Issue", predicate: "REFERENCES", objectKind: "PullRequest" },
  { subjectKind: "PullRequest", predicate: "REFERENCES", objectKind: "Issue" },
  { subjectKind: "Thread", predicate: "REFERENCES", objectKind: "PullRequest" },
  { subjectKind: "Thread", predicate: "REFERENCES", objectKind: "Issue" },
  { subjectKind: "Thread", predicate: "REFERENCES", objectKind: "Decision" },
  { subjectKind: "Issue", predicate: "MENTIONS", objectKind: "File" },
  { subjectKind: "Thread", predicate: "MENTIONS", objectKind: "File" },
  { subjectKind: "Decision", predicate: "MENTIONS", objectKind: "File" },
  { subjectKind: "Decision", predicate: "SUPERSEDES", objectKind: "Decision" },
  // ownership
  { subjectKind: "Team", predicate: "OWNS", objectKind: "Issue" },
  ...PACKAGE_KINDS.map((objectKind) => ({
    subjectKind: "Team",
    predicate: "OWNS",
    objectKind,
  })),
  // cause
  { subjectKind: "Decision", predicate: "INFLUENCES", objectKind: "Service" },
]

/** One-line semantics per predicate, surfaced to the retrieval planner. */
export const PREDICATE_DESCRIPTIONS: Record<string, string> = {
  IMPLEMENTED_IN: "a Service, App or Library lives in this Repository",
  DEPENDS_ON: "runtime dependency on a Service, Database or Library",
  EXPOSES_API: "a Service serves this API",
  CONSUMES_API: "a Service or API calls this API or Operation",
  HAS_OPERATION: "an API has this Operation (method + path)",
  PRODUCES_TO: "a Service publishes to this Stream",
  CONSUMES_FROM: "a Service consumes from this Stream",
  READS_FROM: "a Service reads this Database",
  WRITES_TO: "a Service writes this Database",
  USES_LIBRARY: "a Service uses this Library",
  IMPLEMENTS_PATTERN: "a Service implements this architectural Pattern",
  RUNS_ON: "a Service is deployed on this Infrastructure",
  HAS_INSTRUCTION:
    "a Repository or Service is governed by this InstructionUnit (stated norm)",
  MEMBER_OF_PRIMARY: "an InstructionUnit belongs to this Skill",
  DECLARED_IN:
    "provenance: the InstructionUnit or Decision is stated in this File",
  PART_OF:
    "containment: the File is inside this Repository, Service, App or Library",
  TARGETS: "the PullRequest's base Repository",
  ADDED:
    "change event: the PullRequest added this File (valid_from = merge date)",
  MODIFIED:
    "change event: the PullRequest modified this File (valid_from = merge date)",
  REMOVED:
    "change event: the PullRequest removed this File (valid_from = merge date)",
  RENAMED:
    "change event: the PullRequest renamed a file to this File (valid_from = merge date)",
  REFERENCES:
    "explicit cross-tool link by URL or identifier: Issue and PullRequest reference each other; a Thread references a PullRequest, Issue or Decision",
  MENTIONS:
    "lexical mention of a File in an Issue, Thread or Decision",
  OWNS: "ownership: a Team owns a Service, App or Library (CODEOWNERS) or an Issue (tracker team)",
  INFLUENCES: "a Decision (ADR) shapes this Service",
  SUPERSEDES: "a Decision replaces an earlier Decision",
}

export type AllowedConnections = {
  core: typeof CORE_ALLOWED_CONNECTIONS
  extension: typeof EXTENSION_ALLOWED_CONNECTIONS
}

export function getAllowedConnections(): AllowedConnections {
  return {
    core: CORE_ALLOWED_CONNECTIONS,
    extension: EXTENSION_ALLOWED_CONNECTIONS,
  }
}

/**
 * Validates that (subjectKind, predicate, objectKind) is an allowed connection.
 * Returns true if valid. subjectKind/objectKind can be derived from ID prefix
 */
export function isAllowedConnection(
  subjectKind: string,
  predicate: string,
  objectKind: string,
): boolean {
  const { core, extension } = getAllowedConnections()
  const all = [...core, ...extension]
  return all.some(
    (c) =>
      c.subjectKind === subjectKind &&
      c.predicate === predicate &&
      c.objectKind === objectKind,
  )
}

const GRAPH_EDGE_TYPES = new Set(
  [...CORE_ALLOWED_CONNECTIONS, ...EXTENSION_ALLOWED_CONNECTIONS].map(
    (c) => c.predicate,
  ),
)

const GRAPH_NODE_KINDS = new Set<string>()
for (const c of [
  ...CORE_ALLOWED_CONNECTIONS,
  ...EXTENSION_ALLOWED_CONNECTIONS,
]) {
  GRAPH_NODE_KINDS.add(c.subjectKind)
  GRAPH_NODE_KINDS.add(c.objectKind)
}

/**
 * Returns all predicate types used as graph edge types.
 */
export function getGraphEdgeTypes(): string[] {
  return [...GRAPH_EDGE_TYPES]
}

/**
 * Returns all node kinds used in allowed connections.
 */
export function getGraphNodeKinds(): string[] {
  return [...GRAPH_NODE_KINDS]
}

/**
 * Returns true if the predicate is a valid graph edge type.
 */
export function isValidGraphEdgeType(predicate: string): boolean {
  return GRAPH_EDGE_TYPES.has(predicate)
}

/**
 * Returns true if the kind is a valid graph node kind.
 */
export function isValidGraphNodeKind(kind: string): boolean {
  return GRAPH_NODE_KINDS.has(kind)
}
