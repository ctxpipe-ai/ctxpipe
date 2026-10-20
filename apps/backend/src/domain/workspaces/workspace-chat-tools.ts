import type { ToolExecutionContext } from "@tanstack/ai"
import { z } from "zod"
import { withOrgDbContext } from "../../db/client.js"
import { toToon } from "../../lib/agentToolRuntime.js"
import { runBridgeToolCall } from "../../mcp/correlation.js"
import {
  getWorkspaceProjectionSnapshot,
  type WorkspaceProjectionSnapshot,
} from "../../models/workspaces.js"
import { codeSearch } from "../../retrieval/services/codeSearch.js"
import { listRepositoriesTool } from "../../tools/listRepositories.js"
import { decayWorkspaceSignal } from "./claim-confidence.js"
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
  expandWorkspaceGraph,
  type GraphExpandParams,
  type GraphExpansion,
} from "./graph-expand.js"
import { WorkspaceGraphBuildingError } from "./graph-rebuild.js"
import { searchKnowledge } from "./knowledge-search.js"
import { type PublishedProjection, publishedProjection } from "./revision.js"

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
}): Promise<WorkspaceChatTanstackTool[]> {
  const projection = publishedProjection(input.snapshot.projection)
  if (!projection) return []
  const sha =
    projection.kind === "active" ? projection.revision.sha : projection.sha
  const boundRepositories = input.snapshot.repositories
  const allowed = new Set(boundRepositories.map((repo) => repo.id))
  const expand = (params: GraphExpandParams) =>
    expandWorkspaceGraph({
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      projection,
      ...params,
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
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      activeProjectionSha: sha,
    }),
  )
  tools.push(
    graphLookupTool({ expand, sha }),
    graphNeighborsTool({ expand, sha }),
  )
  return tools.map(withToolCallSpan)
}

/** Each call runs in a span with the facts of an MCP tool span. */
export function withToolCallSpan(
  tool: WorkspaceChatTanstackTool,
): WorkspaceChatTanstackTool {
  return {
    ...tool,
    execute: (args, execution) =>
      runBridgeToolCall(tool.name, () => tool.execute(args, execution)),
  }
}

function hybridSearchTool(input: {
  orgId: string
  workspaceId: string
  activeProjectionSha: string
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
      if (!query.trim()) return "No search query."
      const hits = await searchKnowledge({
        orgId: input.orgId,
        workspaceIds: [input.workspaceId],
        query,
        limit: 8,
      })
      if (hits.length === 0)
        return "No matching knowledge in the active projection."
      return [
        `Workspace projection context (${input.activeProjectionSha}):`,
        ...hits.map((hit) => {
          const claims = hit.claims
            .map((claim) => `- ${claim.predicate ?? "related"} ${claim.to}`)
            .join("\n")
          // `Node` is the id that graph_lookup and graph_neighbors take.
          return `## ${hit.path} (lines ${hit.startLine}-${hit.endLine})\nNode: ${hit.unitId}\n${hit.text.trim().slice(0, 1200)}${claims ? `\nClaims:\n${claims}` : ""}`
        }),
      ].join("\n\n")
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

type ChatGraphTool = {
  expand: (params: GraphExpandParams) => Promise<GraphExpansion>
  sha: string
}

function graphLookupTool(input: ChatGraphTool): WorkspaceChatTanstackTool {
  return {
    ...GRAPH_LOOKUP_DEFINITION,
    execute: async (args) => {
      const nodeId = stringArg(args, "nodeId")
      if (!nodeId) return toToon({ error: "nodeId_required" })
      const graph = await expandOrRetry(() =>
        input.expand({ seeds: [nodeId], maxDepth: 0 }),
      )
      if (!("nodes" in graph)) return toToon(graph)
      const node = graph.nodes[0]
      return toToon({
        projectionSha: input.sha,
        node: node
          ? {
              id: node.id,
              kind: node.kind,
              name: node.name,
              summary: node.summary,
            }
          : null,
      })
    },
  }
}

function graphNeighborsTool(input: ChatGraphTool): WorkspaceChatTanstackTool {
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
      // The expansion keeps at most `limit` valid edges of the node: the
      // strongest edge of each predicate first, then the next of each.
      const graph = await expandOrRetry(() =>
        input.expand({ seeds: [nodeId], maxDepth: 1, maxFanOut: limit }),
      )
      if (!("nodes" in graph)) return toToon(graph)
      const neighbors = graph.edges
        .map((edge) => ({
          edge,
          confidence: decayWorkspaceSignal({ ...edge }),
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .map(({ edge, confidence }) => {
          const node = graph.nodes.find(
            (candidate) =>
              candidate.id ===
              (edge.sourceId === nodeId ? edge.targetId : edge.sourceId),
          )
          return {
            node: node && {
              id: node.id,
              kind: node.kind,
              name: node.name,
              summary: node.summary,
            },
            predicate: edge.predicate,
            confidence,
          }
        })
      return toToon({ projectionSha: input.sha, neighbors })
    },
  }
}

/** A graph that is being built gives the model a retry message, not an error. */
async function expandOrRetry(
  expand: () => Promise<GraphExpansion>,
): Promise<GraphExpansion | { error: string; message: string }> {
  try {
    return await expand()
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
    "Search the knowledge of this Workspace's active projection (full text and meaning). Each hit is the best section of a file, with its line range. Input: { query }.",
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
    })
    const tool = tools.find((tool) => tool.name === definition.name)
    if (!tool)
      throw new Error(`Workspace tool ${definition.name} is unavailable`)
    execution?.abortSignal?.throwIfAborted()
    return tool.execute(args, execution)
  },
}))
