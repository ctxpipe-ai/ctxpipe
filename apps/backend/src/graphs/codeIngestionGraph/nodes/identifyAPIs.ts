import { HumanMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { langfusePipelineCallbacks } from "../../../observability/langfusePipelineMetrics.js"
import { getLogger } from "../../../observability/logger.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import {
  REPO_EXPLORER_TOOLS_HINT,
  standardRepoExplorerTools,
} from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import {
  type ApiSubmission,
  buildApiObjectsAndClaims,
  extractOperationsFromOpenApiSpec,
} from "./identifyApiClaims.js"
import {
  apiDirectoryFromSpecPath,
  discoverOpenApiSpecPaths,
  fetchAndParseOpenApiSpecs,
} from "./openApiSpecDiscovery.js"

function pathMatchesRoot(path: string, root: string): boolean {
  if (root === "./") return true
  return path.startsWith(`${root}/`) || path === root
}

function createIdentifyAPIsTools(capturedApis: { value: ApiSubmission[] }) {
  const operationSchema = z.object({
    method: z
      .string()
      .describe("HTTP method: GET, POST, PUT, PATCH, DELETE, etc."),
    path: z.string().describe("Path e.g. /users, /auth/login"),
  })

  const submitApisTool = tool(
    async ({ apis }) => {
      capturedApis.value.push(...apis)
      return `Recorded ${apis.length} API(s). Total: ${capturedApis.value.length}.`
    },
    {
      name: "submit_apis",
      description: `Call when you discover APIs without a machine-readable OpenAPI file (or to supplement). For each API: path (directory), optional framework, optional routePaths, optional openApiPath if a spec exists but wasn't pre-loaded, and operations ({ method, path }[]) inferred from routes. Do not paste full OpenAPI JSON — use operations only.`,
      schema: z.object({
        apis: z.array(
          z.object({
            path: z
              .string()
              .describe(
                "API directory path in repo, e.g. apps/web/src/app/api",
              ),
            framework: z
              .string()
              .optional()
              .describe("e.g. Next.js, Express, Hono, FastAPI"),
            routePaths: z
              .array(z.string())
              .optional()
              .describe('e.g. ["auth/[...all]", "billing"]'),
            openApiPath: z
              .string()
              .optional()
              .describe("Path to openapi.json/swagger.json if found"),
            operations: z
              .array(operationSchema)
              .optional()
              .describe("Method + path pairs inferred from route files"),
          }),
        ),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitApisTool]
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

Prefer search and narrow list_files paths first; use get_file in preview by default, then startLine/endLine or mode full only when you need more content.

For each API surface without an OpenAPI file, infer operations from route handlers (get_file on route.ts, *.py, etc.) and call submit_apis with path, framework, and operations.

Be thorough. Explore the given roots. Call submit_apis for each distinct API surface you find. Prefer submitting once you have solid evidence for a surface over unbounded exploration.`

export async function identifyAPIs(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, orgId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenObjectKeys = new Set<string>()
  const seenClaimSourceIds = new Set<string>()

  const appendBuilt = (built: {
    objects: ExtractedObject[]
    claims: ExtractedClaim[]
  }) => {
    for (const obj of built.objects) {
      if (seenObjectKeys.has(obj.deduplicationKey)) continue
      seenObjectKeys.add(obj.deduplicationKey)
      objects.push(obj)
    }
    for (const cl of built.claims) {
      if (seenClaimSourceIds.has(cl.sourceId)) continue
      seenClaimSourceIds.add(cl.sourceId)
      claims.push(cl)
    }
  }

  const rootsNeedingLlm: string[] = []

  for (const root of roots) {
    const specPaths = await discoverOpenApiSpecPaths(repositoryId, orgId, root)
    if (specPaths.length === 0) {
      rootsNeedingLlm.push(root)
      continue
    }

    const parsed = await fetchAndParseOpenApiSpecs(
      repositoryId,
      orgId,
      specPaths,
    )
    const submissions: ApiSubmission[] = []
    for (const entry of parsed) {
      if (!entry) continue
      const { specPath, spec } = entry
      submissions.push({
        path: apiDirectoryFromSpecPath(specPath),
        openApiPath: specPath,
        openApiSpec: spec,
        operations: extractOperationsFromOpenApiSpec(spec),
      })
    }

    const svcDeduplicationKey = `svc:${repositoryId}:${root}`
    appendBuilt(
      buildApiObjectsAndClaims({
        apis: submissions,
        repositoryId,
        root,
        targetHash,
        svcDeduplicationKey,
        extractionMethod: "deterministic",
      }),
    )
  }

  const capturedApis: { value: ApiSubmission[] } = { value: [] }
  if (rootsNeedingLlm.length > 0) {
    const tools = createIdentifyAPIsTools(capturedApis)
    const agent = createAgent({
      model: getModel("medium", { temperature: 0.1 }),
      tools,
      contextMiddleware: {
        clearToolUsesTriggerTokens: 160_000,
        clearToolUsesKeepMessages: 16,
        summarizationTriggerTokens: 240_000,
        summarizationKeepMessages: 36,
      },
      systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${rootsNeedingLlm.join(", ")}.

${REPO_EXPLORER_TOOLS_HINT}`,
    })

    const userMessage = `Explore the repository for HTTP APIs for these roots only: ${rootsNeedingLlm.join(", ")}. List and search route patterns; infer operations from route files where there is no OpenAPI spec. Call submit_apis for each API surface.`

    await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      {
        recursionLimit: 220,
        callbacks: langfusePipelineCallbacks({
          step: "codeIngestion.identifyAPIs",
          dimensions: { repositoryId, targetHash },
        }),
      },
    )

    if (capturedApis.value.length === 0) {
      getLogger().warn(
        "identifyAPIs: agent completed without submit_apis for OpenAPI-less roots (no API submissions captured)",
        { repositoryId, targetHash, rootsNeedingLlm },
      )
    }
  }

  for (const root of rootsNeedingLlm) {
    const svcDeduplicationKey = `svc:${repositoryId}:${root}`
    for (const api of capturedApis.value) {
      if (!pathMatchesRoot(api.path, root)) continue
      appendBuilt(
        buildApiObjectsAndClaims({
          apis: [api],
          repositoryId,
          root,
          targetHash,
          svcDeduplicationKey,
          extractionMethod: "llm",
        }),
      )
    }
  }

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
