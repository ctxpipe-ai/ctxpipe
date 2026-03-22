import type { ExtractedClaim, ExtractedObject } from "../schemas.js"

const OPERATIONS_LIMIT = 100
const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "query",
] as const

export function extractOperationsFromOpenApiSpec(
  spec: Record<string, unknown>,
): Array<{ method: string; path: string }> {
  const paths = spec.paths as
    | Record<string, Record<string, unknown>>
    | undefined
  if (!paths || typeof paths !== "object") return []
  const ops: Array<{ method: string; path: string }> = []
  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue
    for (const method of HTTP_METHODS) {
      if (method in pathItem) {
        ops.push({ method: method.toUpperCase(), path })
      }
    }
  }
  return ops.slice(0, OPERATIONS_LIMIT)
}

export type ApiSubmission = {
  path: string
  framework?: string
  routePaths?: string[]
  openApiPath?: string
  openApiSpec?: Record<string, unknown>
  operations?: Array<{ method: string; path: string }>
}

export function buildApiObjectsAndClaims(input: {
  apis: ApiSubmission[]
  repositoryId: string
  root: string
  targetHash: string
  svcDeduplicationKey: string
  extractionMethod: "llm" | "deterministic"
}): { objects: ExtractedObject[]; claims: ExtractedClaim[] } {
  const {
    apis,
    repositoryId,
    root,
    targetHash,
    svcDeduplicationKey,
    extractionMethod,
  } = input
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenApiKeys = new Set<string>()

  for (const api of apis) {
    const path = api.path
    const apiKey = `api:${repositoryId}:${root}:${path}`
    if (seenApiKeys.has(apiKey)) continue
    seenApiKeys.add(apiKey)

    const operations =
      api.operations ??
      (api.openApiSpec ? extractOperationsFromOpenApiSpec(api.openApiSpec) : [])

    const name = path.split("/").pop() ?? "api"
    objects.push({
      kind: "API",
      deduplicationKey: apiKey,
      name,
      summary: `API at ${path}${api.framework ? ` (${api.framework})` : ""}`,
      payload: {
        path,
        framework: api.framework,
        openApiSpec: api.openApiSpec,
        routePaths: api.routePaths,
        openApiPath: api.openApiPath,
      },
    })

    claims.push({
      subjectRef: svcDeduplicationKey,
      subjectKind: "Service",
      objectRef: apiKey,
      objectKind: "API",
      predicate: "EXPOSES_API",
      sourceId: `identifyAPIs:${repositoryId}:${root}:${path}:${targetHash}`,
      sourceType: "git",
      extractionMethod,
      confidence: 0.8,
      provenance: { path, root, framework: api.framework },
    })

    for (const op of operations) {
      const method = op.method.toUpperCase()
      const opPath = op.path.startsWith("/") ? op.path : `/${op.path}`
      const opKey = `op:${repositoryId}:${root}:${path}:${method}:${opPath}`
      objects.push({
        kind: "Operation",
        deduplicationKey: opKey,
        name: `${method} ${opPath}`,
        summary: `${method} ${opPath}`,
        payload: { method, path: opPath, apiPath: path },
      })
      claims.push({
        subjectRef: apiKey,
        subjectKind: "API",
        objectRef: opKey,
        objectKind: "Operation",
        predicate: "HAS_OPERATION",
        sourceId: `identifyAPIs:${repositoryId}:${root}:${path}:${method}:${opPath}:${targetHash}`,
        sourceType: "git",
        extractionMethod,
        confidence: 0.8,
        provenance: { path, root, method, opPath },
      })
    }
  }

  return { objects, claims }
}
