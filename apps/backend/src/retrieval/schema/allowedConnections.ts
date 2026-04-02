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

/**
 * Allowed (subjectKind, predicate, objectKind) for extension layer.
 */
export const EXTENSION_ALLOWED_CONNECTIONS: Array<{
  subjectKind: string
  predicate: string
  objectKind: string
}> = [
  { subjectKind: "Concept", predicate: "RELATES_TO", objectKind: "Concept" },
  { subjectKind: "Concept", predicate: "ABOUT", objectKind: "Service" },
  { subjectKind: "Concept", predicate: "ABOUT", objectKind: "API" },
  { subjectKind: "Topic", predicate: "RELATES_TO", objectKind: "Topic" },
  { subjectKind: "Topic", predicate: "ABOUT", objectKind: "Service" },
  {
    subjectKind: "Capability",
    predicate: "ASSOCIATED_WITH",
    objectKind: "Service",
  },
  { subjectKind: "Decision", predicate: "INFLUENCES", objectKind: "Service" },
  { subjectKind: "Incident", predicate: "MENTIONS", objectKind: "Service" },
  {
    subjectKind: "InstructionUnit",
    predicate: "MEMBER_OF_PRIMARY",
    objectKind: "Skill",
  },
]

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
