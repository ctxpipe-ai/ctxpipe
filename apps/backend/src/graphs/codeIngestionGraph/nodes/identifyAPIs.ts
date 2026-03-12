import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import { createAgent } from "langchain"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getLangfuseHandler } from "../../../observability/langfuse.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import { getFileTool } from "../../../tools/getFile.js"
import { listFilesTool } from "../../../tools/listFiles.js"
import { searchTool } from "../../../tools/search.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"

const OPERATIONS_LIMIT = 100
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"]

function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

type SubmittedApi = {
  path: string
  framework?: string
  routePaths?: string[]
  openApiPath?: string
  openApiSpec?: Record<string, unknown>
  operations?: Array<{ method: string; path: string }>
}

function extractOperationsFromOpenApiSpec(
  spec: Record<string, unknown>,
): Array<{ method: string; path: string }> {
  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined
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

function createIdentifyAPIsTools(capturedApis: { value: SubmittedApi[] }) {
  const operationSchema = z.object({
    method: z.string().describe("HTTP method: GET, POST, PUT, PATCH, DELETE, etc."),
    path: z.string().describe("Path e.g. /users, /auth/login"),
  })

  const submitApisTool = tool(
    async ({ apis }) => {
      capturedApis.value.push(...apis)
      return `Recorded ${apis.length} API(s). Total: ${capturedApis.value.length}.`
    },
    {
      name: "submit_apis",
      description: `Call this when you have discovered one or more APIs. For each API provide path (directory path in repo), optional framework, optional routePaths (sub-routes), optional openApiPath if you found an existing spec file, optional openApiSpec (parsed JSON from openapi.json/swagger.json), and operations (array of { method, path } from the spec or inferred from route files).`,
      schema: z.object({
        apis: z.array(
          z.object({
            path: z.string().describe("API directory path in repo, e.g. apps/web/src/app/api"),
            framework: z.string().optional().describe("e.g. Next.js, Express, Hono, FastAPI"),
            routePaths: z.array(z.string()).optional().describe("e.g. [\"auth/[...all]\", \"billing\"]"),
            openApiPath: z.string().optional().describe("Path to openapi.json/swagger.json if found"),
            openApiSpec: z.record(z.unknown()).optional().describe("Parsed OpenAPI spec JSON"),
            operations: z.array(operationSchema).optional().describe("Method + path pairs from spec or inferred"),
          }),
        ),
      }),
    },
  )
  return [listFilesTool, searchTool, getFileTool, submitApisTool]
}

const SYSTEM_PROMPT = `You are analyzing a repository to detect all REST/HTTP APIs. Look across any language — APIs exist in JavaScript, TypeScript, PHP, Ruby, Python, Go, Kotlin, Java, .NET, C#, C, Rust, Elixir, and more. Do not assume a single stack.

Use list_files on common API directories:
- app/api, api/, routes/, src/app/api, src/routes, src/api (Next.js App Router, etc.)
- Per root: prefix with root path (e.g. apps/web/src/app/api)

Use search for route registration patterns:

| Framework / Language   | Search hints                           |
| ---------------------- | -------------------------------------- |
| Next.js App Router     | file:route.ts path:app/api              |
| Express / Node         | app.get router.post                     |
| Hono                   | createRoute app.openapi                 |
| FastAPI / Flask       | @app.get APIRouter @app.route           |
| Django REST            | @api_view ViewSet                       |
| tRPC                   | trpc.router createCallerFactory         |
| Go (chi, gin, echo)    | Get( Post( Handle(                      |
| Rust (axum, actix)     | route( get( .route(                      |
| PHP (Laravel, Symfony) | Route:: Route::get                      |
| Ruby (Rails)           | get post routes.rb                      |
| Java (Spring)          | @GetMapping @PostMapping               |
| Kotlin (Ktor)          | get( post( routing                      |
| .NET / C#              | MapGet MapPost [HttpGet]                |

For each API:
1. Search for openapi.json, swagger.json, openapi.yaml in or near the API path
2. If found, use get_file to read and parse; include in openApiSpec
3. If no spec, infer operations from route handler files (get_file on route.ts, *.py, etc.)
4. Call submit_apis with path, framework, operations (array of { method, path })

Be thorough. Explore all roots. Call submit_apis for each distinct API surface you find.`

export async function identifyAPIs(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []

  const capturedApis: { value: SubmittedApi[] } = { value: [] }
  const tools = createIdentifyAPIsTools(capturedApis)
  const agent = createAgent({
    model: getModel("medium"),
    tools,
    systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${roots.join(", ")}.`,
  })

  const userMessage = `Explore the repository for APIs. List files in common API directories, search for route patterns across all languages and frameworks. For each API found, search for openapi.json/swagger.json; if found read and parse. Otherwise infer operations from route files. Call submit_apis for each API surface.`

  const stream = await agent.stream(
    { messages: [new HumanMessage(userMessage)] },
    { streamMode: "values", callbacks: [getLangfuseHandler()] },
  )

  for await (const chunk of stream) {
    if (
      typeof chunk === "object" &&
      chunk !== null &&
      "messages" in chunk &&
      Array.isArray((chunk as { messages: unknown[] }).messages)
    ) {
      // Agent running
    }
  }

  const seenApiKeys = new Set<string>()
  for (const root of roots) {
    const svcDeduplicationKey = `svc:${repositoryId}:${root}`
    for (const api of capturedApis.value) {
      const path = api.path
      if (!pathMatchesRoot(path, root)) continue
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
        extractionMethod: "llm",
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
          extractionMethod: "llm",
          confidence: 0.8,
          provenance: { path, root, method, opPath },
        })
      }
    }
  }

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
