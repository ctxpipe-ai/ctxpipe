import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { toToon } from "../../lib/agentToolRuntime.js"
import { findRepositoriesByNormalizedGitUrls } from "../../models/repositories.js"
import {
  getWorkspaceById,
  listLinkedRepositories,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import { listRepositoriesTool } from "../../tools/listRepositories.js"
import { standardRepoExplorerTools } from "../../tools/repoExplorerTools.js"
import {
  codesearchMembershipGitUrls,
  workspaceCheckoutKey,
} from "./derived-stores.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"
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
  invoke: (input: unknown) => Promise<unknown>
}

export const SCIP_GRAPH_TOOL_NAMES = new Set([
  "graph_find_symbol",
  "graph_get_callers",
  "graph_get_callees",
])

const REPOSITORY_ID_SCHEMA = {
  type: "string",
  pattern: "^repo_",
  description: "Repository id with prefix repo_",
}

/** Plain JSON Schema for TanStack. Do not pass LangChain Zod v3 `.schema`. */
export const EXPLORER_INPUT_SCHEMAS: Record<
  string,
  WorkspaceChatTanstackTool["inputSchema"]
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

export function forcedWorkspaceCheckoutArgs(
  args: unknown,
  checkoutKey: string,
): Record<string, unknown> {
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {}
  delete record.checkoutKey
  record.checkoutKey = checkoutKey
  return record
}

export function workspaceGraphLookupCypher(): string {
  return `MATCH (n)
WHERE n.id = $nodeId AND n.orgId = $orgId AND n.workspaceId = $workspaceId
RETURN n
LIMIT 1`
}

export function workspaceGraphNeighborsCypher(): string {
  return `MATCH (start)-[r]-(n)
WHERE start.id = $nodeId
  AND start.orgId = $orgId AND start.workspaceId = $workspaceId
  AND n.orgId = $orgId AND n.workspaceId = $workspaceId
  AND r.projectionSha = $projectionSha
RETURN n, type(r) AS predicate, r.claim_id AS claimId
LIMIT $limit`
}

export async function workspaceChatTools(input: {
  orgId: string
  workspaceId: string
  writeStatus: string
  loadUnits: () => Promise<WorkspaceChatUnit[]>
  activeProjectionSha: string | null
  embedQuery?: (query: string) => Promise<number[]>
  searchObjects?: (
    query: string,
    embedding: number[],
  ) => Promise<Array<{ objectId: string }>>
}): Promise<WorkspaceChatTanstackTool[]> {
  void input.writeStatus
  if (!input.activeProjectionSha?.trim()) return []
  const allowed = await loadAllowedRepositoryIds(input)
  const checkoutKey = workspaceCheckoutKey(input.workspaceId)
  const explorer = [
    listRepositoriesTool as unknown as ExplorerTool,
    ...(standardRepoExplorerTools as unknown as ExplorerTool[]),
  ]
  const tools: WorkspaceChatTanstackTool[] = explorer.map((tool) =>
    wrapExplorerTool({
      tool,
      orgId: input.orgId,
      allowedRepositoryIds: allowed,
      checkoutKey,
      workspaceId: input.workspaceId,
    }),
  )
  tools.unshift(hybridSearchTool(input))
  tools.push(
    graphLookupTool({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
    }),
    graphNeighborsTool({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      projectionSha: input.activeProjectionSha,
    }),
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
  checkoutKey: string
  workspaceId: string
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
      const invokeArgs = SCIP_GRAPH_TOOL_NAMES.has(input.tool.name)
        ? forcedWorkspaceCheckoutArgs(args, input.checkoutKey)
        : DISK_READ_TOOL_NAMES.has(input.tool.name)
          ? {
              ...(args && typeof args === "object" && !Array.isArray(args)
                ? (args as Record<string, unknown>)
                : {}),
              workspaceId: input.workspaceId,
            }
          : (args ?? {})
      return withOrgIdContext({ id: input.orgId, slug: input.orgId }, () =>
        input.tool.invoke(invokeArgs),
      )
    },
  }
}

function graphLookupTool(input: {
  orgId: string
  workspaceId: string
}): WorkspaceChatTanstackTool {
  return {
    name: "graph_lookup",
    description:
      "Look up one FalkorDB knowledge-graph node in this Workspace. Input: { nodeId }.",
    inputSchema: {
      type: "object",
      properties: { nodeId: { type: "string", minLength: 1 } },
      required: ["nodeId"],
    },
    execute: async (args) => {
      const nodeId = stringArg(args, "nodeId")
      if (!nodeId) return toToon({ error: "nodeId_required" })
      try {
        return await withGraphClient(
          { orgId: input.orgId, orgSlug: input.orgId },
          async () => {
            const { records } = await getGraphClient().executeQuery(
              workspaceGraphLookupCypher(),
              {
                nodeId,
                orgId: input.orgId,
                workspaceId: input.workspaceId,
              },
            )
            const node = records[0]?.get("n")
            return toToon({ node: nodeProperties(node, nodeId, input.orgId) })
          },
        )
      } catch (err) {
        log.error({
          step: "workspaceChat.graph_lookup",
          error: err instanceof Error ? err.message : String(err),
        })
        return toToon({ error: "graph_unavailable" })
      }
    },
  }
}

function graphNeighborsTool(input: {
  orgId: string
  workspaceId: string
  projectionSha: string
}): WorkspaceChatTanstackTool {
  return {
    name: "graph_neighbors",
    description:
      "Traverse FalkorDB neighbors of a Workspace knowledge-graph node. Edges must match the active projection SHA. Input: { nodeId, limit? }.",
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
      try {
        return await withGraphClient(
          { orgId: input.orgId, orgSlug: input.orgId },
          async () => {
            const { records } = await getGraphClient().executeQuery(
              workspaceGraphNeighborsCypher(),
              {
                nodeId,
                orgId: input.orgId,
                workspaceId: input.workspaceId,
                projectionSha: input.projectionSha,
                limit,
              },
            )
            return toToon({
              neighbors: records.map((record) => ({
                node: nodeProperties(record.get("n"), "", input.orgId),
                predicate: record.get("predicate"),
                claimId: record.get("claimId"),
              })),
            })
          },
        )
      } catch (err) {
        log.error({
          step: "workspaceChat.graph_neighbors",
          error: err instanceof Error ? err.message : String(err),
        })
        return toToon({ error: "graph_unavailable" })
      }
    },
  }
}

async function loadAllowedRepositoryIds(input: {
  orgId: string
  workspaceId: string
}): Promise<Set<string>> {
  return withOrgDbContext(input.orgId, async () => {
    const workspace = await getWorkspaceById(input.workspaceId)
    const linked = await listLinkedRepositories(input.workspaceId)
    const urls = codesearchMembershipGitUrls({
      activeProjectionUrl: workspace?.activeProjectionUrl ?? null,
      linked,
      normalizeUrl: normalizeWorkspaceRepositoryUrl,
    })
    const rows = await withOrgIdContext(
      { id: input.orgId, slug: input.orgId },
      () => findRepositoriesByNormalizedGitUrls(urls),
    )
    return new Set(rows.map((row) => row.id))
  })
}

function stringArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object") return ""
  const value = (args as Record<string, unknown>)[key]
  return typeof value === "string" ? value.trim() : ""
}

function nodeProperties(
  node: unknown,
  fallbackId: string,
  orgId: string,
): Record<string, unknown> | null {
  if (!node) return null
  const props =
    (node as { properties?: Record<string, unknown> }).properties ??
    (typeof node === "object" ? (node as Record<string, unknown>) : {})
  const toPlain = (value: unknown): unknown =>
    value != null && typeof value === "object" && "toNumber" in value
      ? (value as { toNumber: () => number }).toNumber()
      : value
  return {
    id: String(props.id ?? fallbackId),
    orgId: String(props.orgId ?? orgId),
    ...Object.fromEntries(
      Object.entries(props).map(([key, value]) => [key, toPlain(value)]),
    ),
  }
}
