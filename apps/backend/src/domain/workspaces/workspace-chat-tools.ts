import type { ToolExecutionContext } from "@tanstack/ai"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { toToon } from "../../lib/agentToolRuntime.js"
import {
  getWorkspaceProjectionSnapshot,
  type WorkspaceProjectionSnapshot,
} from "../../models/workspaces.js"
import { hybridSearch } from "../../retrieval/index.js"
import { codeSearch } from "../../retrieval/services/codeSearch.js"
import { generateEmbedding } from "../../retrieval/services/modelProvider.js"
import { listRepositoriesTool } from "../../tools/listRepositories.js"
import {
  CODE_TOOLS,
  type ExplorerTool,
  explorerToolDefinition,
  parseCodeToolArgs,
  repositoryIdFromToolArgs,
  runCodeTool,
  stringArg,
} from "./code-tools.js"
import {
  readOrRebuildWorkspaceGraph,
  WorkspaceGraphBuildingError,
} from "./graph-rebuild.js"
import { type PublishedProjection, publishedProjection } from "./revision.js"
import {
  formatWorkspaceChatHits,
  type WorkspaceChatUnit,
  workspaceChatHybridHits,
} from "./workspace-chat-retrieval.js"
import type { WorkspaceGraphPayload } from "./workspace-graph.js"

export type WorkspaceChatTanstackTool = {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties?: Record<string, unknown>
  } & Record<string, unknown>
  execute: (
    args: unknown,
    context?: Pick<ToolExecutionContext, "context" | "abortSignal">,
  ) => Promise<unknown>
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
  orgSlug: string
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
  const loadGraph = () =>
    readOrRebuildWorkspaceGraph({
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      projection,
    })
  const explorer = [
    listRepositoriesTool as unknown as ExplorerTool,
    ...CODE_TOOLS,
  ]
  const tools: WorkspaceChatTanstackTool[] = explorer.map((tool) =>
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
    graphLookupTool({ loadGraph, sha }),
    graphNeighborsTool({ loadGraph, sha }),
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
    ...HYBRID_SEARCH_DEFINITION,
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

function wrapExplorerTool(input: {
  tool: ExplorerTool
  orgId: string
  allowedRepositoryIds: ReadonlySet<string>
  boundRepositories: WorkspaceProjectionSnapshot["repositories"]
  workspaceId: string
  projection: PublishedProjection
}): WorkspaceChatTanstackTool {
  return {
    ...explorerToolDefinition(input.tool),
    execute: async (args) => {
      if (input.tool.name === "list_repositories") {
        return toToon({
          repositories: [...input.allowedRepositoryIds].map((id) => ({ id })),
        })
      }
      const parsed = parseCodeToolArgs(input.tool.name, args)
      if ("error" in parsed) return parsed.error
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
      const repositoryId = repositoryIdFromToolArgs(args)
      const repository = input.boundRepositories.find(
        (repo) => repo.id === repositoryId,
      )
      if (!repository)
        return toToon({ error: "repository_not_in_workspace", repositoryId })
      return runCodeTool({
        toolName: input.tool.name,
        args: parsed.args,
        orgId: input.orgId,
        checkout: {
          repositoryId: repository.id,
          workspace:
            input.projection.kind === "active"
              ? { workspaceId: input.workspaceId, sha: repository.sha }
              : { workspaceId: input.workspaceId, legacy: true },
        },
        search: async (query) => {
          const matches = await codeSearch(input.orgId, {
            workspaceId: input.workspaceId,
            repositoryIds: [repository.id],
            query,
            workspaceSnapshot: {
              projection: input.projection,
              repositories: input.boundRepositories,
            },
          })
          return matches[0]?.response ?? { Files: [] }
        },
      })
    },
  }
}

function graphLookupTool(input: {
  loadGraph: () => Promise<WorkspaceGraphPayload>
  sha: string
}): WorkspaceChatTanstackTool {
  return {
    ...GRAPH_LOOKUP_DEFINITION,
    execute: async (args) => {
      const nodeId = stringArg(args, "nodeId")
      if (!nodeId) return toToon({ error: "nodeId_required" })
      const graph = await loadGraphOrRetry(input.loadGraph)
      if (!("nodes" in graph)) return toToon(graph)
      return toToon({
        projectionSha: input.sha,
        node: graph.nodes.find((node) => node.id === nodeId) ?? null,
      })
    },
  }
}

function graphNeighborsTool(input: {
  loadGraph: () => Promise<WorkspaceGraphPayload>
  sha: string
}): WorkspaceChatTanstackTool {
  return {
    ...GRAPH_NEIGHBORS_DEFINITION,
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
      const graph = await loadGraphOrRetry(input.loadGraph)
      if (!("nodes" in graph)) return toToon(graph)
      const neighbors = graph.edges
        .filter((edge) => edge.sourceId === nodeId || edge.targetId === nodeId)
        .slice(0, limit)
        .map((edge) => ({
          node: graph.nodes.find(
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

/** A graph that is being built gives the model a retry message, not an error. */
async function loadGraphOrRetry(
  loadGraph: () => Promise<WorkspaceGraphPayload>,
): Promise<WorkspaceGraphPayload | { error: string; message: string }> {
  try {
    return await loadGraph()
  } catch (error) {
    if (!(error instanceof WorkspaceGraphBuildingError)) throw error
    return {
      error: "graph_building",
      message:
        "The Workspace graph is being built. Use the other tools now, and try the graph tools again in a few minutes.",
    }
  }
}

const HYBRID_SEARCH_DEFINITION: Omit<WorkspaceChatTanstackTool, "execute"> = {
  name: "hybrid_search",
  description:
    "Search this Workspace's active projection (Postgres knowledge and claims). Input: { query }.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
  },
}

const GRAPH_LOOKUP_DEFINITION: Omit<WorkspaceChatTanstackTool, "execute"> = {
  name: "graph_lookup",
  description:
    "Look up a node in this Workspace's published knowledge graph. Input: { nodeId }.",
  inputSchema: {
    type: "object",
    properties: { nodeId: { type: "string", minLength: 1 } },
    required: ["nodeId"],
  },
}

const GRAPH_NEIGHBORS_DEFINITION: Omit<WorkspaceChatTanstackTool, "execute"> = {
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
}

const chatToolScope = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  workspaceId: z.string().min(1),
})

/** Static catalogue. Tenant-bound data is read only on an actual tool invocation. */
export const WORKSPACE_CHAT_TOOLS: WorkspaceChatTanstackTool[] = [
  HYBRID_SEARCH_DEFINITION,
  ...[listRepositoriesTool as unknown as ExplorerTool, ...CODE_TOOLS].map(
    (tool) => explorerToolDefinition(tool),
  ),
  GRAPH_LOOKUP_DEFINITION,
  GRAPH_NEIGHBORS_DEFINITION,
].map((definition) => ({
  ...definition,
  execute: async (args, execution) => {
    execution?.abortSignal?.throwIfAborted()
    const scope = chatToolScope.parse(execution?.context)
    const snapshot = await withOrgDbContext(scope.orgId, () =>
      getWorkspaceProjectionSnapshot(scope.workspaceId),
    )
    if (!publishedProjection(snapshot.projection))
      throw new Error("Workspace projection is unavailable")
    const tools = await workspaceChatTools({
      ...scope,
      snapshot,
      embedQuery: generateEmbedding,
      searchObjects: (query, embedding) =>
        hybridSearch(scope.orgId, { embedding, query }, { limit: 20 }),
    })
    const tool = tools.find((tool) => tool.name === definition.name)
    if (!tool)
      throw new Error(`Workspace tool ${definition.name} is unavailable`)
    execution?.abortSignal?.throwIfAborted()
    return tool.execute(args, execution)
  },
}))
