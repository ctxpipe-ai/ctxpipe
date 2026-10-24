import { z } from "zod"
import { toToon } from "../../lib/agentToolRuntime.js"
import { assertStructuralGraphAnchor } from "../../lib/repoExplorerPlanner.js"
import {
  codesearchGraphQuery,
  type GraphPrimitive,
} from "../../tools/codesearchGraph.js"
import {
  type CheckoutFileRequest,
  readCheckoutFile,
} from "../../tools/getFile.js"
import {
  type CheckoutGlobRequest,
  globCheckoutPaths,
} from "../../tools/globFiles.js"
import { standardRepoExplorerTools } from "../../tools/repoExplorerTools.js"
import { codesearchStructuralSearch } from "../../tools/structuralSearch.js"
import { compactSearchResponse } from "../../tools/zoektCompact.js"
import {
  buildSymbolDefinitionQuery,
  buildSymbolReferencesQuery,
} from "../../tools/zoektSymbolQuery.js"
import { withRepositorySourceRevision } from "../codeIngestion/source-revision-context.js"

/**
 * The read-only codesearch tool set that Workspace chat and ingest share.
 * The caller authorizes the call and gives one resolved checkout; this module
 * only runs the tool on that checkout.
 */

export type ExplorerTool = { name: string; description: string }

/**
 * One codesearch checkout: `rev:<sha>` of a source, or a Workspace read,
 * which codesearch serves from the published checkout of the repository.
 */
export type CodeCheckout = { repositoryId: string } & (
  | { source: { sha: string } }
  | { workspace: { workspaceId: string; sha: string } }
)

/** Runs a Zoekt query on the checkout and gives the raw response. */
type CodeCheckoutSearch = (
  query: string,
  detail: "compact" | "full",
) => Promise<Record<string, unknown>>

export const SCIP_GRAPH_TOOL_NAMES = new Set([
  "graph_find_symbol",
  "graph_get_callers",
  "graph_get_callees",
])

/** The checkout tools, without `list_repositories`. */
export const CODE_TOOLS =
  standardRepoExplorerTools as unknown as readonly ExplorerTool[]

const REPOSITORY_ID_SCHEMA: z.core.JSONSchema.JSONSchema = {
  type: "string",
  pattern: "^repo_",
  description: "Repository id with prefix repo_",
}

/** Plain JSON Schema for TanStack. Do not pass the Zod v3 `.schema` of a tool. */
export const EXPLORER_INPUT_SCHEMAS: Record<
  string,
  z.core.JSONSchema.JSONSchema & { type: "object" }
> = {
  list_repositories: { type: "object", properties: {} },
  glob_files: {
    type: "object",
    properties: {
      repositoryId: REPOSITORY_ID_SCHEMA,
      pattern: { type: "string", minLength: 1, maxLength: 512 },
      path: { type: "string" },
      onlyFiles: { type: "boolean" },
      dot: { type: "boolean" },
      limit: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0 },
    },
    required: ["repositoryId", "pattern"],
  },
  search: {
    type: "object",
    properties: {
      repositoryId: REPOSITORY_ID_SCHEMA,
      query: { type: "string", minLength: 1 },
      detail: { type: "string", enum: ["compact", "full"] },
    },
    required: ["repositoryId", "query"],
  },
  find_symbol_definitions: {
    type: "object",
    properties: {
      repositoryId: REPOSITORY_ID_SCHEMA,
      symbol: { type: "string", minLength: 1 },
      language: { type: "string", minLength: 1 },
    },
    required: ["repositoryId", "symbol", "language"],
  },
  find_symbol_references: {
    type: "object",
    properties: {
      repositoryId: REPOSITORY_ID_SCHEMA,
      symbol: { type: "string", minLength: 1 },
      language: { type: "string", minLength: 1 },
    },
    required: ["repositoryId", "symbol", "language"],
  },
  structural_search: {
    type: "object",
    properties: {
      repositoryId: REPOSITORY_ID_SCHEMA,
      pattern: { type: "string", minLength: 1 },
      lang: { type: "string", minLength: 1 },
      paths: { type: "array", items: { type: "string", minLength: 1 } },
      globs: { type: "array", items: { type: "string", minLength: 1 } },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["repositoryId", "pattern"],
  },
  graph_find_symbol: {
    type: "object",
    properties: {
      repositoryId: REPOSITORY_ID_SCHEMA,
      symbol: { type: "string", minLength: 1 },
      filePath: { type: "string", minLength: 1 },
      module: { type: "string", minLength: 1 },
    },
    required: ["repositoryId"],
  },
  graph_get_callers: {
    type: "object",
    properties: {
      repositoryId: REPOSITORY_ID_SCHEMA,
      symbol: { type: "string", minLength: 1 },
      filePath: { type: "string", minLength: 1 },
      module: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["repositoryId"],
  },
  graph_get_callees: {
    type: "object",
    properties: {
      repositoryId: REPOSITORY_ID_SCHEMA,
      symbol: { type: "string", minLength: 1 },
      filePath: { type: "string", minLength: 1 },
      module: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["repositoryId"],
  },
  get_file: {
    type: "object",
    properties: {
      repositoryId: REPOSITORY_ID_SCHEMA,
      path: { type: "string", minLength: 1 },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      maxChars: { type: "integer", minimum: 1 },
      mode: { type: "string", enum: ["preview", "full"] },
    },
    required: ["repositoryId", "path"],
  },
}

export function repositoryIdFromToolArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  const repositoryId = (args as { repositoryId?: unknown }).repositoryId
  return typeof repositoryId === "string" && repositoryId.startsWith("repo_")
    ? repositoryId
    : null
}

export function stringArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return ""
  const value = (args as Record<string, unknown>)[key]
  return typeof value === "string" ? value.trim() : ""
}

/** The model-facing name, description, and schema of one explorer tool. */
export function explorerToolDefinition(
  tool: ExplorerTool,
  graphCheckoutText = "Uses this Workspace's codesearch checkout.",
) {
  const schema = EXPLORER_INPUT_SCHEMAS[tool.name] ?? {
    type: "object" as const,
    properties: {},
  }
  return {
    name: tool.name,
    description: SCIP_GRAPH_TOOL_NAMES.has(tool.name)
      ? `${tool.description.replace(/Requires checkoutKey[^.]*\./gi, "").trim()} ${graphCheckoutText}`
      : tool.description,
    inputSchema: schema,
  }
}

const SEARCH_TOOL_NAMES = new Set([
  "search",
  "find_symbol_definitions",
  "find_symbol_references",
])

function searchQuery(toolName: string, args: unknown): string {
  if (toolName === "search") return stringArg(args, "query")
  const symbol = stringArg(args, "symbol")
  const language = stringArg(args, "language")
  if (!symbol || !language) return ""
  return toolName === "find_symbol_definitions"
    ? buildSymbolDefinitionQuery(symbol, language)
    : buildSymbolReferencesQuery(symbol, language)
}

/**
 * Validate a tool's input before any repository or checkout check. A search
 * without a repository or a query gets `search_input_required`; other bad
 * input throws.
 */
export function parseCodeToolArgs(
  toolName: string,
  args: unknown,
): { error: string } | { args: Record<string, unknown> } {
  if (
    SEARCH_TOOL_NAMES.has(toolName) &&
    (!repositoryIdFromToolArgs(args) || !searchQuery(toolName, args))
  )
    return { error: toToon({ error: "search_input_required" }) }
  const schema = EXPLORER_INPUT_SCHEMAS[toolName]
  if (!schema)
    throw new Error(`Unsupported Workspace explorer tool: ${toolName}`)
  return {
    args: z.fromJSONSchema(schema).parse(args) as Record<string, unknown>,
  }
}

/**
 * Run one checkout tool with input from `parseCodeToolArgs` on an authorized
 * checkout. A source checkout reads with a source revision claim; a Workspace
 * checkout with a Workspace claim.
 */
export async function runCodeTool(input: {
  toolName: string
  args: Record<string, unknown>
  orgId: string
  checkout: CodeCheckout
  search: CodeCheckoutSearch
}): Promise<unknown> {
  const { toolName, args, checkout } = input
  const repositoryId = checkout.repositoryId
  const repository = { id: repositoryId, orgId: input.orgId }
  const workspace = "workspace" in checkout ? checkout.workspace : undefined
  const run = async (): Promise<unknown> => {
    if (SEARCH_TOOL_NAMES.has(toolName)) {
      const query = searchQuery(toolName, args)
      const detail = stringArg(args, "detail") === "full" ? "full" : "compact"
      const response = await input.search(query, detail)
      return toToon({
        repositoryId,
        query,
        ...(detail === "full" ? { response } : compactSearchResponse(response)),
      })
    }
    if (toolName === "glob_files") {
      const parsed = args as unknown as CheckoutGlobRequest
      return globCheckoutPaths({
        pattern: parsed.pattern,
        path: parsed.path,
        onlyFiles: parsed.onlyFiles,
        dot: parsed.dot,
        limit: parsed.limit,
        offset: parsed.offset,
        repositoryId,
        orgId: input.orgId,
        ...(workspace ?? {}),
      })
    }
    if (toolName === "get_file") {
      const parsed = args as unknown as CheckoutFileRequest
      return readCheckoutFile({
        path: parsed.path,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        maxChars: parsed.maxChars,
        mode: parsed.mode,
        repositoryId,
        orgId: input.orgId,
        ...(workspace ?? {}),
      })
    }
    if (toolName === "structural_search")
      return codesearchStructuralSearch(
        repository,
        args as {
          pattern: string
          lang?: string
          paths?: string[]
          globs?: string[]
          limit?: number
        },
        workspace,
      )
    if (SCIP_GRAPH_TOOL_NAMES.has(toolName)) {
      const anchor = {
        symbol: stringArg(args, "symbol") || undefined,
        filePath: stringArg(args, "filePath") || undefined,
        module: stringArg(args, "module") || undefined,
      }
      assertStructuralGraphAnchor(anchor)
      return toToon(
        await codesearchGraphQuery(
          repository,
          {
            primitive: toolName.slice("graph_".length) as GraphPrimitive,
            ...anchor,
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          },
          workspace,
        ),
      )
    }
    throw new Error(`Unsupported Workspace explorer tool: ${toolName}`)
  }
  return "source" in checkout
    ? withRepositorySourceRevision(
        { orgId: input.orgId, repositoryId, sha: checkout.source.sha },
        run,
      )
    : run()
}
