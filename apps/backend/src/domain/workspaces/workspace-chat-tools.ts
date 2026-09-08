import { codesearchStructuralSearch } from "../../tools/structuralSearch.js"
import { z } from "zod"
import { assertStructuralGraphAnchor } from "../../lib/repoExplorerPlanner.js"
import {
  codesearchGraphQuery,
  type GraphPrimitive,
} from "../../tools/codesearchGraph.js"
import { toToon } from "../../lib/agentToolRuntime.js"
import { type WorkspaceProjectionSnapshot } from "../../models/workspaces.js"
import { codeSearch } from "../../retrieval/services/codeSearch.js"
import { compactSearchResponse } from "../../tools/zoektCompact.js"
import {
  buildSymbolDefinitionQuery,
  buildSymbolReferencesQuery,
} from "../../tools/zoektSymbolQuery.js"
import { listRepositoriesTool } from "../../tools/listRepositories.js"
import { standardRepoExplorerTools } from "../../tools/repoExplorerTools.js"
import { publishedProjection, type PublishedProjection } from "./revision.js"
import {
  workspaceGraphFromUnits,
  type WorkspaceGraphPayload,
} from "./workspace-graph.js"
import {
  formatWorkspaceChatHits,
  type WorkspaceChatUnit,
  workspaceChatHybridHits,
} from "./workspace-chat-retrieval.js"

export type WorkspaceChatTanstackTool = {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties?: Record<string, unknown>
  } & Record<string, unknown>
  execute: (args: unknown) => Promise<unknown>
}

type ExplorerTool = {
  name: string
  description: string
}

export const SCIP_GRAPH_TOOL_NAMES = new Set([
  "graph_find_symbol",
  "graph_get_callers",
  "graph_get_callees",
])

const REPOSITORY_ID_SCHEMA: z.core.JSONSchema.JSONSchema = {
  type: "string",
  pattern: "^repo_",
  description: "Repository id with prefix repo_",
}

/** Plain JSON Schema for TanStack. Do not pass LangChain Zod v3 `.schema`. */
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

export function workspaceChatToolAllowed(input: {
  toolName: string
  args: unknown
  allowedRepositoryIds: ReadonlySet<string>
}): boolean {
  if (
    input.toolName === "hybrid_search" ||
    input.toolName === "list_repositories" ||
    input.toolName === "graph_lookup" ||
    input.toolName === "graph_neighbors"
  ) {
    return true
  }
  const repositoryId = repositoryIdFromToolArgs(input.args)
  if (!repositoryId) return false
  return input.allowedRepositoryIds.has(repositoryId)
}

export async function workspaceChatTools(input: {
  orgId: string
  workspaceId: string
  snapshot: WorkspaceProjectionSnapshot
  embedQuery?: (query: string) => Promise<number[]>
  searchObjects?: (
    query: string,
    embedding: number[],
  ) => Promise<Array<{ objectId: string }>>
}): Promise<WorkspaceChatTanstackTool[]> {
  const projection = publishedProjection(input.snapshot.projection)
  if (!projection) return []
  const sha =
    projection.kind === "active" ? projection.revision.sha : projection.sha
  const boundRepositories = input.snapshot.repositories
  const allowed = new Set(boundRepositories.map((repo) => repo.id))
  const graph = workspaceGraphFromUnits({ units: input.snapshot.units })
  const explorer = [
    listRepositoriesTool as unknown as ExplorerTool,
    ...(standardRepoExplorerTools as unknown as ExplorerTool[]),
  ]
  const tools: WorkspaceChatTanstackTool[] = explorer
    .filter((tool) => !DISK_READ_TOOL_NAMES.has(tool.name))
    .map((tool) =>
      wrapExplorerTool({
        tool,
        orgId: input.orgId,
        allowedRepositoryIds: allowed,
        boundRepositories,
        workspaceId: input.workspaceId,
        projection,
      }),
    )
  tools.unshift(
    hybridSearchTool({
      ...input,
      activeProjectionSha: sha,
      loadUnits: async () => input.snapshot.units,
    }),
  )
  tools.push(
    graphLookupTool({ graph, sha }),
    graphNeighborsTool({ graph, sha }),
  )
  return tools
}

function hybridSearchTool(input: {
  orgId: string
  loadUnits: () => Promise<WorkspaceChatUnit[]>
  activeProjectionSha: string | null
  embedQuery?: (query: string) => Promise<number[]>
  searchObjects?: (
    query: string,
    embedding: number[],
  ) => Promise<Array<{ objectId: string }>>
}): WorkspaceChatTanstackTool {
  return {
    name: "hybrid_search",
    description:
      "Search this Workspace's active projection (Postgres knowledge and claims). Input: { query }.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
    },
    execute: async (args) => {
      const query =
        args &&
        typeof args === "object" &&
        typeof (args as { query?: unknown }).query === "string"
          ? (args as { query: string }).query
          : ""
      if (!query.trim() || !input.activeProjectionSha) {
        return "No active Workspace projection."
      }
      const units = await input.loadUnits()
      let embedding: number[] | null = null
      let objectHits: Array<{ objectId: string }> = []
      if (input.embedQuery) {
        try {
          embedding = await input.embedQuery(query)
          if (input.searchObjects && embedding) {
            objectHits = await input.searchObjects(query, embedding)
          }
        } catch {
          embedding = null
        }
      }
      const hits = workspaceChatHybridHits({
        query,
        activeProjectionSha: input.activeProjectionSha,
        units,
        embedding,
        objectHits,
      })
      return (
        formatWorkspaceChatHits({
          activeProjectionSha: input.activeProjectionSha,
          hits,
        }) || "No matching knowledge in the active projection."
      )
    },
  }
}

const DISK_READ_TOOL_NAMES = new Set(["get_file", "glob_files"])

function wrapExplorerTool(input: {
  tool: ExplorerTool
  orgId: string
  allowedRepositoryIds: ReadonlySet<string>
  boundRepositories: WorkspaceProjectionSnapshot["repositories"]
  workspaceId: string
  projection: PublishedProjection
}): WorkspaceChatTanstackTool {
  const schema = EXPLORER_INPUT_SCHEMAS[input.tool.name] ?? {
    type: "object" as const,
    properties: {},
  }
  return {
    name: input.tool.name,
    description: SCIP_GRAPH_TOOL_NAMES.has(input.tool.name)
      ? `${input.tool.description.replace(/Requires checkoutKey[^.]*\./gi, "").trim()} Uses this Workspace's codesearch checkout.`
      : input.tool.description,
    inputSchema: schema,
    execute: async (args) => {
      if (
        !workspaceChatToolAllowed({
          toolName: input.tool.name,
          args,
          allowedRepositoryIds: input.allowedRepositoryIds,
        })
      ) {
        return toToon({
          error: "repository_not_in_workspace",
          repositoryId: repositoryIdFromToolArgs(args),
        })
      }
      if (input.tool.name === "list_repositories") {
        return toToon({
          repositories: [...input.allowedRepositoryIds].map((id) => ({ id })),
        })
      }
      if (
        [
          "search",
          "find_symbol_definitions",
          "find_symbol_references",
        ].includes(input.tool.name)
      ) {
        const query =
          input.tool.name === "search"
            ? stringArg(args, "query")
            : input.tool.name === "find_symbol_definitions"
              ? buildSymbolDefinitionQuery(
                  stringArg(args, "symbol"),
                  stringArg(args, "language"),
                )
              : buildSymbolReferencesQuery(
                  stringArg(args, "symbol"),
                  stringArg(args, "language"),
                )
        const repositoryId = repositoryIdFromToolArgs(args)
        if (!query || !repositoryId)
          return toToon({ error: "search_input_required" })
        const matches = await codeSearch(input.orgId, {
          workspaceId: input.workspaceId,
          repositoryIds: [repositoryId],
          query,
          workspaceSnapshot: {
            projection: input.projection,
            repositories: input.boundRepositories,
          },
        })
        const response = matches[0]?.response ?? { Files: [] }
        return toToon({
          repositoryId,
          query,
          ...(stringArg(args, "detail") === "full"
            ? { response }
            : compactSearchResponse(response)),
        })
      }
      if (input.tool.name === "structural_search") {
        const parsed = z.fromJSONSchema(schema).parse(args) as {
          repositoryId: string
          pattern: string
          lang?: string
          paths?: string[]
          globs?: string[]
          limit?: number
        }
        const repository = input.boundRepositories.find(
          (repo) => repo.id === parsed.repositoryId,
        )
        if (!repository)
          return toToon({
            error: "repository_not_in_workspace",
            repositoryId: parsed.repositoryId,
          })
        return codesearchStructuralSearch(
          { id: repository.id, orgId: input.orgId },
          parsed,
          {
            workspaceId: input.workspaceId,
            ...(input.projection.kind === "active"
              ? { sha: repository.sha }
              : { legacy: true as const }),
          },
        )
      }
      if (SCIP_GRAPH_TOOL_NAMES.has(input.tool.name)) {
        const parsed = z.fromJSONSchema(schema).parse(args) as Record<
          string,
          unknown
        >
        const repositoryId = repositoryIdFromToolArgs(parsed)
        const repository = input.boundRepositories.find(
          (repo) => repo.id === repositoryId,
        )
        if (!repository)
          return toToon({ error: "repository_not_in_workspace", repositoryId })
        const anchor = {
          symbol: stringArg(parsed, "symbol") || undefined,
          filePath: stringArg(parsed, "filePath") || undefined,
          module: stringArg(parsed, "module") || undefined,
        }
        assertStructuralGraphAnchor(anchor)
        return toToon(
          await codesearchGraphQuery(
            { id: repository.id, orgId: input.orgId },
            {
              primitive: input.tool.name.slice(
                "graph_".length,
              ) as GraphPrimitive,
              ...anchor,
              ...(typeof parsed.limit === "number"
                ? { limit: parsed.limit }
                : {}),
            },
            {
              workspaceId: input.workspaceId,
              ...(input.projection.kind === "active"
                ? { sha: repository.sha }
                : { legacy: true as const }),
            },
          ),
        )
      }
      throw new Error(`Unsupported Workspace explorer tool: ${input.tool.name}`)
    },
  }
}

function graphLookupTool(input: {
  graph: WorkspaceGraphPayload
  sha: string
}): WorkspaceChatTanstackTool {
  return {
    name: "graph_lookup",
    description:
      "Look up a node in this Workspace's published knowledge graph. Input: { nodeId }.",
    inputSchema: {
      type: "object",
      properties: { nodeId: { type: "string", minLength: 1 } },
      required: ["nodeId"],
    },
    execute: async (args) => {
      const nodeId = stringArg(args, "nodeId")
      if (!nodeId) return toToon({ error: "nodeId_required" })
      return toToon({
        projectionSha: input.sha,
        node: input.graph.nodes.find((node) => node.id === nodeId) ?? null,
      })
    },
  }
}

function graphNeighborsTool(input: {
  graph: WorkspaceGraphPayload
  sha: string
}): WorkspaceChatTanstackTool {
  return {
    name: "graph_neighbors",
    description:
      "Traverse neighbors in this Workspace's published knowledge graph. Input: { nodeId, limit? }.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["nodeId"],
    },
    execute: async (args) => {
      const nodeId = stringArg(args, "nodeId")
      if (!nodeId) return toToon({ error: "nodeId_required" })
      const limitRaw =
        args && typeof args === "object"
          ? (args as { limit?: unknown }).limit
          : undefined
      const limit =
        typeof limitRaw === "number" && Number.isFinite(limitRaw)
          ? Math.min(50, Math.max(1, Math.floor(limitRaw)))
          : 20
      const neighbors = input.graph.edges
        .filter((edge) => edge.sourceId === nodeId || edge.targetId === nodeId)
        .slice(0, limit)
        .map((edge) => ({
          node: input.graph.nodes.find(
            (node) =>
              node.id ===
              (edge.sourceId === nodeId ? edge.targetId : edge.sourceId),
          ),
          predicate: edge.predicate,
          confidence: edge.confidence,
        }))
      return toToon({ projectionSha: input.sha, neighbors })
    },
  }
}

function stringArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return ""
  const value = (args as Record<string, unknown>)[key]
  return typeof value === "string" ? value.trim() : ""
}
