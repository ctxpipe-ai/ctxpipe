/**
 * Allowed (subjectType, predicate, objectType) triples for core graph.
 * Operational types: Repository (repo_*), CodeChunk (obj_*) are implicit.
 */
export const CORE_ALLOWED_CONNECTIONS: Array<{
  subjectType: string
  predicate: string
  objectType: string
}> = [
  { subjectType: "Service", predicate: "RUNS_ON", objectType: "Repository" },
  { subjectType: "Service", predicate: "DEPENDS_ON", objectType: "Database" },
  { subjectType: "Service", predicate: "DEPENDS_ON", objectType: "Service" },
  { subjectType: "Service", predicate: "DEPENDS_ON", objectType: "Library" },
  { subjectType: "Service", predicate: "EXPOSES_API", objectType: "API" },
  { subjectType: "Service", predicate: "CONSUMES_API", objectType: "API" },
  { subjectType: "Service", predicate: "PRODUCES_TO", objectType: "Stream" },
  { subjectType: "Service", predicate: "CONSUMES_FROM", objectType: "Stream" },
  { subjectType: "Service", predicate: "READS_FROM", objectType: "Database" },
  { subjectType: "Service", predicate: "WRITES_TO", objectType: "Database" },
  { subjectType: "Service", predicate: "USES_LIBRARY", objectType: "Library" },
  { subjectType: "Service", predicate: "IMPLEMENTS_PATTERN", objectType: "Pattern" },
  { subjectType: "Service", predicate: "RUNS_ON", objectType: "Infrastructure" },
  { subjectType: "API", predicate: "CONSUMES_API", objectType: "API" },
  { subjectType: "Repository", predicate: "contains", objectType: "CodeChunk" },
]

/**
 * Allowed (subjectType, predicate, objectType) for extension layer.
 */
export const EXTENSION_ALLOWED_CONNECTIONS: Array<{
  subjectType: string
  predicate: string
  objectType: string
}> = [
  { subjectType: "Concept", predicate: "RELATES_TO", objectType: "Concept" },
  { subjectType: "Concept", predicate: "ABOUT", objectType: "Service" },
  { subjectType: "Concept", predicate: "ABOUT", objectType: "API" },
  { subjectType: "Topic", predicate: "RELATES_TO", objectType: "Topic" },
  { subjectType: "Topic", predicate: "ABOUT", objectType: "Service" },
  { subjectType: "Capability", predicate: "ASSOCIATED_WITH", objectType: "Service" },
  { subjectType: "Decision", predicate: "INFLUENCES", objectType: "Service" },
  { subjectType: "Incident", predicate: "MENTIONS", objectType: "Service" },
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
 * Validates that (subjectType, predicate, objectType) is an allowed connection.
 * Returns true if valid. subjectType/objectType can be derived from ID prefix
 * (repo_ -> Repository, obj_ -> CodeChunk) or from retrieval_objects.type.
 */
export function isAllowedConnection(
  subjectType: string,
  predicate: string,
  objectType: string,
): boolean {
  const { core, extension } = getAllowedConnections()
  const all = [...core, ...extension]
  return all.some(
    (c) =>
      c.subjectType === subjectType &&
      c.predicate === predicate &&
      c.objectType === objectType,
  )
}
