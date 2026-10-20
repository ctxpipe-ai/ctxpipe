import { SpanStatusCode } from "@opentelemetry/api"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { recordSpans } from "../../../test/spans.js"
import type { WorkspaceProjectionSnapshot } from "../../models/workspaces.js"
import {
  EXPLORER_INPUT_SCHEMAS,
  repositoryIdFromToolArgs,
  SCIP_GRAPH_TOOL_NAMES,
} from "./code-tools.js"
import type { PublishedProjection } from "./revision.js"
import {
  WORKSPACE_CHAT_TOOLS,
  withToolCallSpan,
  workspaceChatToolAllowed,
  workspaceChatTools,
} from "./workspace-chat-tools.js"

const spans = recordSpans()

const CODESEARCH = "http://codesearch.chat-tools.test"
const SHA = "d".repeat(40)
const seen: Array<{
  path: string
  claims: Record<string, unknown>
  body: unknown
}> = []

function jwtClaims(header: string | null): Record<string, unknown> {
  const payload = header?.replace(/^Bearer /, "").split(".")[1] ?? ""
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
}

const server = setupServer(
  http.post(`${CODESEARCH}/:repositoryId/files-query`, async ({ request }) => {
    const body = (await request.json()) as { paths: string[] }
    seen.push({
      path: new URL(request.url).pathname,
      claims: jwtClaims(request.headers.get("authorization")),
      body,
    })
    return HttpResponse.json({
      [body.paths[0] ?? ""]: Buffer.from("owner: billing\n").toString("base64"),
    })
  }),
  http.post(`${CODESEARCH}/search`, async ({ request }) => {
    seen.push({
      path: new URL(request.url).pathname,
      claims: jwtClaims(request.headers.get("authorization")),
      body: await request.json(),
    })
    return HttpResponse.json({
      Result: {
        Files: [
          {
            FileName: "src/billing.ts",
            RepositoryID: 7,
            Version: SHA,
            LineMatches: [
              {
                LineNumber: 2,
                Line: Buffer.from("billing()").toString("base64"),
              },
            ],
          },
        ],
      },
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
beforeEach(() => {
  vi.stubEnv("CODESEARCH_URL", CODESEARCH)
  vi.stubEnv("AUTH_SECRET", "chat-tools-test-secret-0123456789abcdef")
  seen.length = 0
})
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

/** Explorer tools read only the projection kind and the bound checkouts. */
function snapshot(
  projection: Pick<PublishedProjection, "kind">,
): WorkspaceProjectionSnapshot {
  return {
    projection: {
      ...projection,
      ...(projection.kind === "legacy"
        ? { url: null, sha: SHA }
        : { revision: { sha: SHA }, stores: {} }),
    } as PublishedProjection,
    units: [],
    chunksMissing: false,
    repositories: [
      {
        id: "repo_bound",
        name: "bound",
        gitUrl: "https://example.test/bound.git",
        zoektRepoId: 7,
        sha: SHA,
        checkoutKey: `ws:ws_chat:${SHA}`,
      },
    ],
  }
}

async function tool(name: string, kind: "active" | "legacy" = "active") {
  const tools = await workspaceChatTools({
    orgId: "org_chat",
    orgSlug: "chat",
    workspaceId: "ws_chat",
    snapshot: snapshot({ kind }),
  })
  const found = tools.find((item) => item.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

describe("workspace chat explorer tools (msw codesearch)", () => {
  it("reads a bound repository at its Workspace revision", async () => {
    const result = await (await tool("get_file")).execute({
      repositoryId: "repo_bound",
      path: "OWNERS",
    })
    expect(String(result)).toContain("owner: billing")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.path).toBe("/repo_bound/files-query")
    expect(seen[0]?.claims).toMatchObject({
      workspaceId: "ws_chat",
      workspaceRevisions: [{ repositoryId: "repo_bound", sha: SHA }],
    })
  })

  it("reads the legacy Workspace checkout of a legacy projection", async () => {
    await (await tool("get_file", "legacy")).execute({
      repositoryId: "repo_bound",
      path: "OWNERS",
    })
    expect(seen[0]?.claims).toMatchObject({
      workspaceId: "ws_chat",
      legacyWorkspace: true,
    })
    expect(seen[0]?.claims).not.toHaveProperty("workspaceRevisions")
  })

  it("searches the bound Zoekt repository and keeps compact output", async () => {
    const result = String(
      await (await tool("search")).execute({
        repositoryId: "repo_bound",
        query: "billing",
      }),
    )
    expect(result).toContain("repo_bound")
    expect(result).toContain("src/billing.ts")
    expect(seen[0]?.path).toBe("/search")
    expect(seen[0]?.body).toMatchObject({ RepoIDs: [7] })
    expect(seen[0]?.claims).toMatchObject({
      workspaceRevisions: [{ repositoryId: "repo_bound", sha: SHA }],
    })
  })

  it("answers search_input_required to a search with no repository or query", async () => {
    const search = await tool("search")
    for (const args of [{ query: "billing" }, { repositoryId: "repo_bound" }])
      expect(String(await search.execute(args))).toContain(
        "search_input_required",
      )
    expect(seen).toHaveLength(0)
  })

  it("refuses a repository outside the Workspace and calls no codesearch", async () => {
    const result = String(
      await (await tool("get_file")).execute({
        repositoryId: "repo_unrelated",
        path: "OWNERS",
      }),
    )
    expect(result).toContain("repository_not_in_workspace")
    expect(seen).toHaveLength(0)
  })
})

describe("workspace chat tool call spans", () => {
  const callSpan = (name: string) => spans.spanNamed(`bridge.tool ${name}`)

  it("records the call id and the size of a result", async () => {
    const result = String(
      await withToolCallSpan(await tool("get_file")).execute({
        repositoryId: "repo_bound",
        path: "OWNERS",
      }),
    )

    expect(callSpan("get_file")?.attributes).toMatchObject({
      "ctxpipe.mcp.tool": "get_file",
      "ctxpipe.mcp.call.id": expect.stringMatching(/^call_/),
      "ctxpipe.mcp.result.bytes": Buffer.byteLength(result),
    })
    expect(callSpan("get_file")?.attributes["ctxpipe.mcp.error.code"]).toBe(
      undefined,
    )
  })

  it("records the error code of an error result, and no argument", async () => {
    await withToolCallSpan(await tool("get_file")).execute({
      repositoryId: "repo_unrelated",
      path: "SECRET_PATH",
    })

    const span = callSpan("get_file")
    expect(span?.attributes["ctxpipe.mcp.error.code"]).toBe(
      "repository_not_in_workspace",
    )
    expect(JSON.stringify(span?.attributes)).not.toContain("SECRET_PATH")
  })

  it("records an internal error of a tool that throws", async () => {
    server.use(
      http.post(`${CODESEARCH}/:repositoryId/files-query`, () =>
        HttpResponse.error(),
      ),
    )

    await expect(
      withToolCallSpan(await tool("get_file")).execute({
        repositoryId: "repo_bound",
        path: "OWNERS",
      }),
    ).rejects.toThrow()

    expect(callSpan("get_file")?.attributes["ctxpipe.mcp.error.code"]).toBe(
      "internal",
    )
  })

  it("covers a failure before the tool runs, such as a context that has no scope", async () => {
    const listed = WORKSPACE_CHAT_TOOLS.find((item) => item.name === "get_file")
    if (!listed) throw new Error("missing tool get_file")

    await expect(
      withToolCallSpan(listed).execute({ repositoryId: "repo_bound" }),
    ).rejects.toThrow()

    expect(callSpan("get_file")?.attributes).toMatchObject({
      "ctxpipe.mcp.tool": "get_file",
      "ctxpipe.mcp.error.code": "internal",
    })
    expect(callSpan("get_file")?.status.code).toBe(SpanStatusCode.ERROR)
  })
})

describe("workspace explorer input policy", () => {
  it("allows workspace tools and rejects repositories outside the captured membership", () => {
    const repositoryId = "repo_published"
    const allowedRepositoryIds = new Set([repositoryId])
    expect(
      workspaceChatToolAllowed({
        toolName: "hybrid_search",
        args: { query: "billing" },
        allowedRepositoryIds,
      }),
    ).toBe(true)
    expect(
      workspaceChatToolAllowed({
        toolName: "graph_lookup",
        args: { nodeId: "kn_1" },
        allowedRepositoryIds,
      }),
    ).toBe(true)
    expect(
      workspaceChatToolAllowed({
        toolName: "search",
        args: { repositoryId, query: "billing" },
        allowedRepositoryIds,
      }),
    ).toBe(true)
    expect(
      workspaceChatToolAllowed({
        toolName: "search",
        args: { repositoryId: "repo_unrelated", query: "billing" },
        allowedRepositoryIds,
      }),
    ).toBe(false)
    expect(repositoryIdFromToolArgs({ repositoryId })).toBe(repositoryId)
  })

  it("keeps checkout selection out of model-facing SCIP schemas", () => {
    for (const name of SCIP_GRAPH_TOOL_NAMES)
      expect(EXPLORER_INPUT_SCHEMAS[name]?.properties).not.toHaveProperty(
        "checkoutKey",
      )
  })
})
