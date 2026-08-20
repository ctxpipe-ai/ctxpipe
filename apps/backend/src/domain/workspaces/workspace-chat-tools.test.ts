import { beforeEach, describe, expect, it, vi } from "vitest"
import { graphFindSymbolTool } from "../../tools/codegraphTools.js"
import { workspaceCheckoutKey } from "./derived-stores.js"
import {
  EXPLORER_INPUT_SCHEMAS,
  forcedWorkspaceCheckoutArgs,
  repositoryIdFromToolArgs,
  SCIP_GRAPH_TOOL_NAMES,
  workspaceChatToolAllowed,
  workspaceChatTools,
  workspaceGraphLookupCypher,
  workspaceGraphNeighborsCypher,
} from "./workspace-chat-tools.js"

const getWorkspaceById = vi.hoisted(() => vi.fn())
const listLinkedRepositories = vi.hoisted(() => vi.fn())
const findRepositoriesByNormalizedGitUrls = vi.hoisted(() => vi.fn())
const executeQuery = vi.hoisted(() =>
  vi.fn(async () => ({
    records: [] as Array<{ get: (key: string) => unknown }>,
  })),
)
const orgTxDepth = vi.hoisted(() => ({ value: 0 }))
const graphInTx = vi.hoisted(() => ({ value: false, seen: false }))

vi.mock("../../db/client.js", () => ({
  tryGetOrgDb: () => (orgTxDepth.value > 0 ? {} : undefined),
  tryGetOrgDbOrgId: () => (orgTxDepth.value > 0 ? "org_1" : undefined),
  assertNotInOrgDbContext: () => undefined,

  withOrgDbContext: async (_orgId: string, fn: () => unknown) => {
    orgTxDepth.value += 1
    try {
      return await fn()
    } finally {
      orgTxDepth.value -= 1
    }
  },
}))

vi.mock("../../auth/withAuth.js", () => ({
  withOrgIdContext: (_org: unknown, fn: () => unknown) => fn(),
}))

vi.mock("../../models/workspaces.js", () => ({
  getWorkspaceById,
  listLinkedRepositories,
}))

vi.mock("../../models/repositories.js", () => ({
  findRepositoriesByNormalizedGitUrls,
}))

vi.mock("../../platform/graph/client.js", () => ({
  withGraphClient: (_ctx: unknown, fn: () => unknown) => {
    graphInTx.seen = true
    graphInTx.value = orgTxDepth.value > 0
    return fn()
  },
  getGraphClient: () => ({ executeQuery }),
}))

const DOCS_ID = "repo_aaaaaaaaaaaaaaaaaaaaaaaa"
const APP_ID = "repo_bbbbbbbbbbbbbbbbbbbbbbbb"
const NEW_ID = "repo_cccccccccccccccccccccccc"

describe("workspace chat tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    orgTxDepth.value = 0
    graphInTx.seen = false
    graphInTx.value = false
    getWorkspaceById.mockResolvedValue({
      id: "ws_1",
      workspaceRepositoryUrl: "https://github.com/acme/new",
      activeProjectionUrl: "https://github.com/acme/docs",
      activeProjectionSha: "abc",
    })
    listLinkedRepositories.mockResolvedValue([
      { gitUrl: "https://github.com/acme/app" },
    ])
    findRepositoriesByNormalizedGitUrls.mockImplementation(
      async (urls: readonly string[]) =>
        urls.flatMap((url) => {
          if (url.includes("docs")) return [{ id: DOCS_ID, gitUrl: url }]
          if (url.includes("app")) return [{ id: APP_ID, gitUrl: url }]
          if (url.includes("new")) return [{ id: NEW_ID, gitUrl: url }]
          return []
        }),
    )
  })

  it("scopes explorer tools to the Workspace repository allowlist", () => {
    const allowed = new Set([DOCS_ID])
    expect(
      workspaceChatToolAllowed({
        toolName: "hybrid_search",
        args: { query: "billing" },
        allowedRepositoryIds: allowed,
      }),
    ).toBe(true)
    expect(
      workspaceChatToolAllowed({
        toolName: "graph_lookup",
        args: { nodeId: "kn_1" },
        allowedRepositoryIds: allowed,
      }),
    ).toBe(true)
    expect(
      workspaceChatToolAllowed({
        toolName: "search",
        args: { repositoryId: DOCS_ID, query: "x" },
        allowedRepositoryIds: allowed,
      }),
    ).toBe(true)
    expect(
      workspaceChatToolAllowed({
        toolName: "search",
        args: { repositoryId: NEW_ID, query: "x" },
        allowedRepositoryIds: allowed,
      }),
    ).toBe(false)
    expect(
      repositoryIdFromToolArgs({
        repositoryId: DOCS_ID,
      }),
    ).toBe(DOCS_ID)
  })

  it("returns no retrieval tools without an active projection SHA", async () => {
    await expect(
      workspaceChatTools({
        orgId: "org_1",
        workspaceId: "ws_1",
        writeStatus: "writable",
        activeProjectionSha: null,
        loadUnits: async () => [],
      }),
    ).resolves.toEqual([])
    expect(getWorkspaceById).not.toHaveBeenCalled()
  })

  it("exposes JSON Schema objects and omits checkoutKey from the model", async () => {
    const tools = await workspaceChatTools({
      orgId: "org_1",
      workspaceId: "ws_1",
      writeStatus: "writable",
      activeProjectionSha: "abc",
      loadUnits: async () => [],
    })
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "hybrid_search",
        "list_repositories",
        "search",
        "graph_find_symbol",
        "graph_lookup",
        "graph_neighbors",
      ]),
    )
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object")
      expect(tool.inputSchema.properties).not.toHaveProperty("checkoutKey")
    }
    for (const name of SCIP_GRAPH_TOOL_NAMES) {
      expect(EXPLORER_INPUT_SCHEMAS[name]?.properties).not.toHaveProperty(
        "checkoutKey",
      )
    }
  })

  it("resolves codesearch membership from the active projection URL", async () => {
    const tools = await workspaceChatTools({
      orgId: "org_1",
      workspaceId: "ws_1",
      writeStatus: "writable",
      activeProjectionSha: "abc",
      loadUnits: async () => [],
    })
    expect(findRepositoriesByNormalizedGitUrls).toHaveBeenCalledWith([
      "https://github.com/acme/docs",
      "https://github.com/acme/app",
    ])
    const list = tools.find((tool) => tool.name === "list_repositories")
    const listed = await list?.execute({})
    expect(String(listed)).toContain(DOCS_ID)
    expect(String(listed)).toContain(APP_ID)
    expect(String(listed)).not.toContain(NEW_ID)
  })

  it("strips a caller checkoutKey and injects the Workspace checkout", async () => {
    const invoke = vi
      .spyOn(graphFindSymbolTool, "invoke")
      .mockResolvedValue("ok")
    const tools = await workspaceChatTools({
      orgId: "org_1",
      workspaceId: "ws_1",
      writeStatus: "writable",
      activeProjectionSha: "abc",
      loadUnits: async () => [],
    })
    const graph = tools.find((tool) => tool.name === "graph_find_symbol")
    await graph?.execute({
      repositoryId: DOCS_ID,
      checkoutKey: "default",
      symbol: "Ledger",
    })
    expect(invoke).toHaveBeenCalledWith({
      repositoryId: DOCS_ID,
      symbol: "Ledger",
      checkoutKey: workspaceCheckoutKey("ws_1"),
    })
    expect(
      forcedWorkspaceCheckoutArgs({ checkoutKey: "default" }, "ws:ws_1"),
    ).toEqual({ checkoutKey: "ws:ws_1" })
    invoke.mockRestore()
  })

  it("scopes Falkor Cypher to org, workspace, and projection SHA on edges", () => {
    expect(workspaceGraphLookupCypher()).toContain(
      "n.workspaceId = $workspaceId",
    )
    expect(workspaceGraphLookupCypher()).toContain("n.orgId = $orgId")
    expect(workspaceGraphNeighborsCypher()).toContain(
      "r.projectionSha = $projectionSha",
    )
    expect(workspaceGraphNeighborsCypher()).toContain(
      "start.workspaceId = $workspaceId",
    )
  })

  it("runs Falkor lookup against the Workspace graph", async () => {
    executeQuery.mockResolvedValueOnce({
      records: [
        {
          get: () => ({ id: "kn_1", orgId: "org_1", workspaceId: "ws_1" }),
        },
      ],
    })
    const tools = await workspaceChatTools({
      orgId: "org_1",
      workspaceId: "ws_1",
      writeStatus: "writable",
      activeProjectionSha: "abc",
      loadUnits: async () => [],
    })
    const lookup = tools.find((tool) => tool.name === "graph_lookup")
    const result = await lookup?.execute({ nodeId: "kn_1" })
    expect(executeQuery).toHaveBeenCalledWith(workspaceGraphLookupCypher(), {
      nodeId: "kn_1",
      orgId: "org_1",
      workspaceId: "ws_1",
    })
    expect(String(result)).toContain("kn_1")
    expect(graphInTx.seen).toBe(true)
    expect(graphInTx.value).toBe(false)
  })
})
