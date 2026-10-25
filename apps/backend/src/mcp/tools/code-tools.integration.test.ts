import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { eq, inArray, sql } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { registerMcpRoutes } from "../../routes/mcp.js"
import { withTestRequestLogger } from "../../test/hono-test-logger.js"
import { insertLinkedRepositoryRows } from "../../test/workspace-links-fixture.js"
import { loadOrgRepositoryHandles } from "../framework/call-workspace.js"
import { parseRef } from "../framework/refs.js"
import { registerMcpReadTools } from "../framework/tool-registry.js"
import { findSymbolTool } from "./find-symbol.js"
import { searchCodeTool } from "./search-code.js"

const server = useMswServer()
let seed: SeededOrg
let client: Client
const workspaceId = generateObjectId("ws")
const repositoryId = generateObjectId("repo")
let zoektRepoId: number
let requests: Record<string, unknown>[] = []

function createApp() {
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use(evlog())
  app.use("*", async (c, next) => {
    c.set("env", parseEnv(process.env as Record<string, string | undefined>))
    c.set("user", null)
    c.set("session", null)
    c.set("oauthReferenceId", null)
    c.set("oauthClientId", null)
    c.set("orgApiKey", null)
    c.set("personalApiKeyId", null)
    c.set("orgSlug", null)
    c.set("orgId", null)
    await next()
  })
  registerMcpRoutes(app, {
    registerTools: (server) =>
      registerMcpReadTools(server, [searchCodeTool, findSymbolTool]),
  })
  return app
}

/** `credential`: an `x-api-key` value, or the request headers to send. */
async function connect(
  credential: string | Record<string, string> = seed.orgApiKey,
  path = "/mcp",
): Promise<Client> {
  const app = createApp()
  const client = new Client({ name: "framework-test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost${path}`), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: {
        headers:
          typeof credential === "string"
            ? { "x-api-key": credential }
            : credential,
      },
    }),
  )
  // Real clients list the tools first. Then the SDK Client checks each
  // result against the output schema of the tool.
  await client.listTools()
  return client
}

async function callTool(
  request: Parameters<Client["callTool"]>[0],
): Promise<CallToolResult> {
  return (await client.callTool(request)) as CallToolResult
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  vi.stubEnv("BETTER_AUTH_API_KEY", "")
  vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
  seed = await seedOrg()
  expect(
    (await getSystemDb().execute(sql`select current_user as role`)).rows[0],
  ).toEqual({ role: "ctxpipe_app" })
  await withOrgDbContext(seed.orgId, async (db) => {
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId: seed.orgId,
      slug: "payments",
      displayName: "Payments",
      workspaceRepositoryUrl: `/tmp/code-tools-${workspaceId}`,
      desiredDefaultBranch: "main",
    })
    await insertLinkedRepositoryRows(
      db,
      ["alpha", "unindexed"].map((name) => ({
        id: generateObjectId("wlr"),
        orgId: seed.orgId,
        workspaceId,
        gitUrl: `https://github.com/example/${name}.git`,
      })),
    )
    await db.insert(repositories).values({
      id: repositoryId,
      orgId: seed.orgId,
      name: "example/alpha",
      gitUrl: "https://github.com/example/alpha.git",
    })
    const [checkout] = await db
      .insert(repositoryCheckouts)
      .values({
        id: generateObjectId("checkout"),
        orgId: seed.orgId,
        repositoryId,
        checkoutKey: "default",
        ref: "main",
        commitSha: "a".repeat(40),
      })
      .returning({ zoektRepoId: repositoryCheckouts.zoektRepoId })
    if (!checkout) throw new Error("No checkout")
    zoektRepoId = checkout.zoektRepoId
  })
  client = await connect()
})

afterAll(async () => {
  await client?.close()
  if (seed) {
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId))
      await db.delete(repositories).where(eq(repositories.orgId, seed.orgId))
    })
    await cleanupSeededOrg(seed)
  }
  vi.unstubAllEnvs()
})

it("searches literal text and returns a file ref, served revision, and skipped repositories", async () => {
  requests = []
  server.use(
    http.post("http://codesearch.test/search", async ({ request }) => {
      requests.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json({
        Result: {
          Files: [
            {
              FileName: "src/index.ts",
              RepositoryID: zoektRepoId,
              Language: "TypeScript",
              LineMatches: [3, 5, 8, 13].map((line) => ({
                LineNumber: line,
                Line: Buffer.from(`charge(${line})`).toString("base64"),
              })),
            },
          ],
        },
      })
    }),
  )
  const result = await callTool({
    name: "search_code",
    arguments: {
      org: seed.orgSlug,
      query: "charge(1)",
      mode: "literal",
      excludeRepositories: [],
    },
  })
  expect(result.isError).not.toBe(true)
  // One entry for each file: the match count, the language, and the first
  // three matches.
  expect(result.structuredContent).toMatchObject({
    files: [
      {
        ref: "example/alpha:src/index.ts",
        language: "TypeScript",
        matchCount: 4,
        matches: [
          { startLine: 3, endLine: 3, snippet: "charge(3)" },
          { startLine: 5, endLine: 5, snippet: "charge(5)" },
          { startLine: 8, endLine: 8, snippet: "charge(8)" },
        ],
        served: { branch: "main", sha: "a".repeat(40) },
      },
    ],
    excluded: [],
    skipped: [{ repository: "example/unindexed", reason: "not_indexed" }],
    truncated: false,
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    Q: '"charge(1)"',
    RepoIDs: [zoektRepoId],
  })
})

it("sends regex syntax unchanged and reports rejected syntax without a literal retry", async () => {
  requests = []
  server.use(
    http.post("http://codesearch.test/search", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      return body.Q === "charge(("
        ? HttpResponse.json(
            { code: "query_rejected", error: "Missing closing parenthesis" },
            { status: 400 },
          )
        : HttpResponse.json({ Result: { Files: [] } })
    }),
  )
  const call = (query: string) =>
    callTool({
      name: "search_code",
      arguments: {
        org: seed.orgSlug,
        query,
        mode: "regex",
        excludeRepositories: [],
      },
    })
  expect((await call("charge\\(.*\\)")).isError).not.toBe(true)
  const bad = await call("charge((")
  expect(bad.isError).toBe(true)
  expect(bad._meta?.["ai.ctxpipe/error"]).toMatchObject({
    code: "invalid_argument",
    retryable: false,
  })
  expect(requests.map((body) => body.Q)).toEqual(["charge\\(.*\\)", "charge(("])
})

it("narrows a search to a path glob and sets the case rule", async () => {
  requests = []
  server.use(
    http.post("http://codesearch.test/search", async ({ request }) => {
      requests.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json({ Result: { Files: [] } })
    }),
    http.post(
      "http://codesearch.test/:repository/structural-search",
      async ({ request }) => {
        requests.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ matches: [] })
      },
    ),
  )
  const call = (args: Record<string, unknown>) =>
    callTool({
      name: "search_code",
      arguments: { org: seed.orgSlug, excludeRepositories: [], ...args },
    })
  for (const args of [
    {
      query: "Charge",
      mode: "literal",
      pathGlob: "src/**/*.{ts,tsx}",
      caseSensitive: true,
    },
    { query: "a|b", mode: "regex", caseSensitive: false },
    {
      query: "charge($A)",
      mode: "structural",
      language: "typescript",
      pathGlob: "src/*.ts",
    },
  ])
    expect((await call(args)).isError).not.toBe(true)
  expect(requests.map((body) => body.Q ?? body)).toEqual([
    '"Charge" file:"^src/(?:.*/)?[^/]*\\\\.(?:ts|tsx)$" case:yes',
    "(a|b) case:no",
    {
      pattern: "charge($A)",
      lang: "typescript",
      globs: ["src/*.ts"],
      limit: 11,
    },
  ])
  const open = await call({ query: "x", mode: "literal", pathGlob: "src/{a" })
  expect(open._meta?.["ai.ctxpipe/error"]).toMatchObject({
    code: "invalid_argument",
  })
  expect(requests).toHaveLength(3)

  // One meaning in every mode: a glob with no / matches at any depth.
  expect(
    (await call({ query: "x", mode: "literal", pathGlob: "*.ts" })).isError,
  ).not.toBe(true)
  expect(requests.at(-1)?.Q).toBe('"x" file:"^(?:.*/)?[^/]*\\\\.ts$"')
  // No ! negation in any mode, and a regex cannot close the (...) group early.
  for (const args of [
    { query: "x", mode: "literal", pathGlob: "!*.ts" },
    {
      query: "x",
      mode: "structural",
      language: "typescript",
      pathGlob: "!*.ts",
    },
    { query: "a) file:x (b", mode: "regex", caseSensitive: true },
    { query: "a\\", mode: "regex", pathGlob: "*.ts" },
  ]) {
    const refused = await call(args)
    expect(refused._meta?.["ai.ctxpipe/error"]).toMatchObject({
      code: "invalid_argument",
    })
  }
  expect(requests).toHaveLength(4)
})

it("requires a language for structural search and converts ast-grep matches to file refs", async () => {
  requests = []
  server.use(
    http.post(
      "http://codesearch.test/:repository/structural-search",
      async ({ request }) => {
        requests.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({
          matches: [
            {
              file: `/cache/${seed.orgId}/${repositoryId}/checkouts/default/src/index.ts`,
              text: "charge(1)",
              range: {
                start: { line: 2, column: 0 },
                end: { line: 2, column: 9 },
              },
            },
          ],
        })
      },
    ),
  )
  const args = {
    org: seed.orgSlug,
    query: "charge($A)",
    mode: "structural",
    excludeRepositories: [],
  }
  expect(
    (await callTool({ name: "search_code", arguments: args })).isError,
  ).toBe(true)
  expect(requests).toEqual([])
  const result = await callTool({
    name: "search_code",
    arguments: { ...args, language: "typescript" },
  })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toMatchObject({
    files: [
      {
        ref: "example/alpha:src/index.ts",
        language: "TypeScript",
        matchCount: 1,
        matches: [{ startLine: 3, endLine: 3, snippet: "charge(1)" }],
        served: { branch: "main", sha: "a".repeat(40) },
      },
    ],
  })
  expect(requests).toEqual([
    { pattern: "charge($A)", lang: "typescript", limit: 11 },
  ])
  expect(JSON.stringify(result)).not.toContain(repositoryId)
})

it("returns SCIP definitions and references as one-based file locations", async () => {
  requests = []
  server.use(
    http.post(
      "http://codesearch.test/:repository/graph",
      async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        requests.push(body)
        return HttpResponse.json({
          ok: true,
          results: [
            {
              symbol: "scip-typescript npm example 1 charge().",
              symbol_name: "charge",
              kind: "function",
              file_path: `/cache/${seed.orgId}/${repositoryId}/checkouts/default/src/index.ts`,
              range: {
                start_line: body.primitive === "find_symbol" ? 2 : 7,
                end_line: body.primitive === "find_symbol" ? 2 : 7,
                start_character: 0,
                end_character: 6,
              },
            },
          ],
        })
      },
    ),
  )
  for (const relation of ["definition", "references"]) {
    const result = await callTool({
      name: "find_symbol",
      arguments: {
        org: seed.orgSlug,
        symbol: "charge",
        relation,
        excludeRepositories: [],
        filePath: "src/index.ts",
      },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          ref: "example/alpha:src/index.ts",
          startLine: relation === "definition" ? 3 : 8,
          symbol: "scip-typescript npm example 1 charge().",
          name: "charge",
          kind: "function",
          served: { branch: "main", sha: "a".repeat(40) },
        },
      ],
      skipped: [{ repository: "example/unindexed", reason: "not_indexed" }],
      excluded: [],
    })
    expect(JSON.stringify(result)).not.toContain(repositoryId)
  }
  expect(requests).toEqual([
    {
      primitive: "find_symbol",
      symbol: "charge",
      filePath: "src/index.ts",
      limit: 21,
    },
    {
      primitive: "find_references",
      symbol: "charge",
      filePath: "src/index.ts",
      limit: 21,
    },
  ])
})

it("returns caller and callee names with call-site and definition refs", async () => {
  requests = []
  server.use(
    http.post(
      "http://codesearch.test/:repository/graph",
      async ({ request }) => {
        requests.push((await request.json()) as Record<string, unknown>)
        const prefix = `/cache/${seed.orgId}/${repositoryId}/checkouts/default/`
        return HttpResponse.json({
          ok: true,
          results: [
            {
              caller: "checkout",
              caller_symbol: "checkout().",
              called: "charge",
              called_symbol: "charge().",
              caller_file_path: `${prefix}src/checkout.ts`,
              call_file_path: `${prefix}src/checkout.ts`,
              called_file_path: `${prefix}src/charge.ts`,
              call_range: {
                start_line: 9,
                end_line: 9,
                start_character: 0,
                end_character: 8,
              },
            },
          ],
        })
      },
    ),
  )
  for (const relation of ["callers", "callees"]) {
    const result = await callTool({
      name: "find_symbol",
      arguments: {
        org: seed.orgSlug,
        symbol: "charge",
        relation,
        excludeRepositories: [],
      },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          ref: "example/alpha:src/checkout.ts",
          startLine: 10,
          caller: "checkout",
          callerSymbol: "checkout().",
          callerRef: "example/alpha:src/checkout.ts",
          callee: "charge",
          calleeSymbol: "charge().",
          calleeRef: "example/alpha:src/charge.ts",
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(repositoryId)
  }
  expect(requests.map((body) => body.primitive)).toEqual([
    "get_callers",
    "get_callees",
  ])
})

it("bounds large search results and marks truncation instead of returning response_too_large", async () => {
  server.use(
    http.post("http://codesearch.test/search", () =>
      HttpResponse.json({
        Result: {
          Files: Array.from({ length: 40 }, (_, file) => ({
            FileName: `src/file-${file}.ts`,
            RepositoryID: zoektRepoId,
            LineMatches: Array.from({ length: 3 }, (_, i) => ({
              LineNumber: i + 1,
              Line: Buffer.from("charge".repeat(10000)).toString("base64"),
            })),
          })),
        },
      }),
    ),
  )
  const result = await callTool({
    name: "search_code",
    arguments: {
      org: seed.orgSlug,
      query: "charge",
      mode: "literal",
      excludeRepositories: [],
      limit: 30,
    },
  })
  expect(result.isError).not.toBe(true)
  // Each snippet is cut to 1,000 characters, so three files of three
  // matches fit in the budget.
  expect(result.structuredContent).toMatchObject({
    truncated: true,
    files: [
      { ref: "example/alpha:src/file-0.ts", matchCount: 3 },
      { ref: "example/alpha:src/file-1.ts", matchCount: 3 },
      { ref: "example/alpha:src/file-2.ts", matchCount: 3 },
    ],
  })
  expect(
    JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
    }).length,
  ).toBeLessThanOrEqual(24000)
  expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(
    20000,
  )
})

it("bounds symbol results after adding public refs and served revisions", async () => {
  server.use(
    http.post("http://codesearch.test/:repository/graph", () =>
      HttpResponse.json({
        ok: true,
        results: Array.from({ length: 100 }, () => ({
          symbol: "s".repeat(1000),
          symbol_name: "n".repeat(1000),
          kind: "function",
          file_path: `/cache/${seed.orgId}/${repositoryId}/checkouts/default/src/index.ts`,
          range: { start_line: 0, end_line: 0 },
        })),
      }),
    ),
  )
  const result = await callTool({
    name: "find_symbol",
    arguments: {
      org: seed.orgSlug,
      symbol: "charge",
      relation: "definition",
      excludeRepositories: [],
      limit: 100,
    },
  })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent?.truncated).toBe(true)
  expect(
    (result.structuredContent?.results as unknown[]).length,
  ).toBeGreaterThan(0)
  expect(
    JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
    }).length,
  ).toBeLessThanOrEqual(24000)
})

it("preserves the fan-out limit, excluded repositories, skips, and narrowing hint", async () => {
  const ids: string[] = []
  const wideWorkspaceId = generateObjectId("ws")
  await withOrgDbContext(seed.orgId, async (db) => {
    await db.insert(workspaces).values({
      id: wideWorkspaceId,
      orgId: seed.orgId,
      slug: "wide",
      displayName: "Wide",
      workspaceRepositoryUrl: `/tmp/${wideWorkspaceId}`,
    })
    for (let index = 0; index < 12; index++) {
      const id = generateObjectId("repo")
      ids.push(id)
      const name = `example/wide-${String(index).padStart(2, "0")}`
      const gitUrl = `https://github.com/${name}.git`
      await insertLinkedRepositoryRows(db, {
        id: generateObjectId("wlr"),
        orgId: seed.orgId,
        workspaceId: wideWorkspaceId,
        gitUrl,
      })
      await db
        .insert(repositories)
        .values({ id, orgId: seed.orgId, name, gitUrl })
      await db.insert(repositoryCheckouts).values({
        id: generateObjectId("checkout"),
        repositoryId: id,
        orgId: seed.orgId,
        checkoutKey: "default",
        ref: "main",
        commitSha: "b".repeat(40),
      })
    }
  })
  // The wide Workspace adds repositories to the org scope. Remove it, so later
  // tests see only the seeded repository.
  try {
    let requested: string[] = []
    server.use(
      http.post("http://codesearch.test/:repository/graph", ({ params }) => {
        requested.push(String(params.repository))
        return HttpResponse.json({
          ok: true,
          results: [],
          ...(params.repository === ids[2] ? { index: "unreadable" } : {}),
        })
      }),
      http.post(
        "http://codesearch.test/:repository/structural-search",
        ({ params }) => {
          requested.push(String(params.repository))
          return HttpResponse.json({ matches: [] })
        },
      ),
    )
    for (const [name, args] of [
      ["find_symbol", { symbol: "charge", relation: "definition" }],
      [
        "search_code",
        { query: "charge($A)", mode: "structural", language: "typescript" },
      ],
    ] as const) {
      requested = []
      const result = await callTool({
        name,
        arguments: {
          org: seed.orgSlug,
          workspace: "wide",
          excludeRepositories: ["git@github.com:example/wide-01.git"],
          ...args,
        },
      })
      expect(result.isError).not.toBe(true)
      expect(requested).toHaveLength(10)
      expect(requested).not.toContain(ids[1])
      expect(requested).not.toContain(ids[11])
      expect(result.structuredContent?.excluded).toEqual(["example/wide-01"])
      expect(result.structuredContent?.skipped).toContainEqual({
        repository: "example/wide-11",
        reason: "over_limit",
      })
      if (name === "find_symbol")
        expect(result.structuredContent?.skipped).toContainEqual({
          repository: "example/wide-02",
          reason: "failed",
        })
      expect(result.structuredContent?.hint).toMatch(/repositories.*workspace/)
    }
  } finally {
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.delete(workspaces).where(eq(workspaces.id, wideWorkspaceId))
      await db.delete(repositories).where(inArray(repositories.id, ids))
    })
  }
})

it("requires exclusions and advertises read-only schemas through tools/list", async () => {
  const listed = (await client.listTools()).tools
  expect(listed.map((tool) => tool.name)).toEqual([
    "search_code",
    "find_symbol",
  ])
  for (const tool of listed) {
    expect(tool.inputSchema.required).toContain("excludeRepositories")
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(tool.outputSchema).toBeDefined()
    const result = await callTool({
      name: tool.name,
      arguments: {
        org: seed.orgSlug,
        query: "charge",
        mode: "literal",
        symbol: "charge",
        relation: "definition",
      },
    })
    expect(result.isError).toBe(true)
  }
})

it("never requests an excluded repository in any mode or relation", async () => {
  let requestCount = 0
  server.use(
    http.all("http://codesearch.test/*", () => {
      requestCount += 1
      return HttpResponse.json(
        { error: "Excluded repository was requested" },
        { status: 400 },
      )
    }),
  )
  for (const exclusion of [
    "example/alpha",
    "https://github.com/example/alpha.git",
    "git@github.com:example/alpha.git",
  ]) {
    const scope = {
      org: seed.orgSlug,
      workspace: "payments",
      excludeRepositories: [exclusion],
    }
    for (const mode of ["literal", "regex", "structural"]) {
      const result = await callTool({
        name: "search_code",
        arguments: { ...scope, query: "charge", mode, language: "typescript" },
      })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({
        files: [],
        excluded: ["example/alpha"],
        skipped: [{ repository: "example/unindexed", reason: "not_indexed" }],
      })
    }
    for (const relation of ["definition", "references", "callers", "callees"]) {
      const result = await callTool({
        name: "find_symbol",
        arguments: { ...scope, symbol: "charge", relation },
      })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent?.excluded).toEqual(["example/alpha"])
    }
  }
  expect(requestCount).toBe(0)
})

it("returns the same denial for an existing foreign org and the same unknown slug", async () => {
  const foreignId = generateObjectId("org")
  const slug = `foreign-${foreignId.slice(-8)}`
  await getSystemDb().insert(organizations).values({
    id: foreignId,
    slug,
    name: "Foreign fixture",
    createdAt: new Date(),
  })
  const call = (name: string) =>
    callTool({
      name,
      arguments: {
        org: slug,
        query: "charge",
        mode: "literal",
        symbol: "charge",
        relation: "definition",
        excludeRepositories: [],
      },
    })
  try {
    const foreign = await Promise.all([
      call("search_code"),
      call("find_symbol"),
    ])
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, foreignId))
    const unknown = await Promise.all([
      call("search_code"),
      call("find_symbol"),
    ])
    for (let index = 0; index < 2; index++) {
      expect(foreign[index]?.isError).toBe(true)
      expect(foreign[index]?._meta?.["ai.ctxpipe/error"]).toMatchObject({
        code: "org_not_found",
      })
      expect(foreign[index]?._meta?.["ai.ctxpipe/error"]).toEqual(
        unknown[index]?._meta?.["ai.ctxpipe/error"],
      )
    }
  } finally {
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, foreignId))
  }
})

it("resolves search refs with the shared file resolver and refuses unknown scopes", async () => {
  server.use(
    http.post("http://codesearch.test/search", () =>
      HttpResponse.json({
        Result: {
          Files: [
            {
              FileName: "src/index.ts",
              RepositoryID: zoektRepoId,
              LineMatches: [
                {
                  LineNumber: 1,
                  Line: Buffer.from("charge(1)").toString("base64"),
                },
              ],
            },
          ],
        },
      }),
    ),
  )
  const args = {
    org: seed.orgSlug,
    workspace: "payments",
    query: "charge",
    mode: "literal",
    excludeRepositories: [],
  }
  const result = await callTool({ name: "search_code", arguments: args })
  expect(result.isError).not.toBe(true)
  const items = result.structuredContent?.files as Array<{ ref: string }>
  const handles = await loadOrgRepositoryHandles({
    id: seed.orgId,
    slug: seed.orgSlug,
  })
  expect(parseRef(items[0]?.ref ?? "", handles)).toMatchObject({
    kind: "file",
    handle: "example/alpha",
    path: "src/index.ts",
  })
  const workspace = await callTool({
    name: "search_code",
    arguments: { ...args, workspace: "missing" },
  })
  expect(workspace._meta?.["ai.ctxpipe/error"]).toMatchObject({
    code: "workspace_not_found",
  })
  const repository = await callTool({
    name: "search_code",
    arguments: { ...args, repositories: ["example/wide-00"] },
  })
  expect(repository._meta?.["ai.ctxpipe/error"]).toMatchObject({
    code: "repository_not_found",
  })
})

it("reports a missing SCIP index and a rejected structural pattern", async () => {
  server.use(
    http.post("http://codesearch.test/:repository/graph", () =>
      HttpResponse.json({ ok: true, results: [], index: "missing" }),
    ),
    http.post("http://codesearch.test/:repository/structural-search", () =>
      HttpResponse.json({ error: "Invalid pattern" }, { status: 400 }),
    ),
  )
  const scope = {
    org: seed.orgSlug,
    workspace: "payments",
    excludeRepositories: [],
    repositories: ["example/alpha"],
  }
  const symbol = await callTool({
    name: "find_symbol",
    arguments: { ...scope, symbol: "charge", relation: "references" },
  })
  expect(symbol.structuredContent).toMatchObject({
    results: [],
    skipped: [{ repository: "example/alpha", reason: "not_indexed" }],
  })
  const structural = await callTool({
    name: "search_code",
    arguments: {
      ...scope,
      query: "broken($A",
      mode: "structural",
      language: "typescript",
    },
  })
  expect(structural.isError).toBe(true)
  expect(structural._meta?.["ai.ctxpipe/error"]).toMatchObject({
    code: "invalid_argument",
  })
})

it("reads the checkout key of any revision out of a code path", async () => {
  const sha = "c".repeat(40)
  server.use(
    http.post("http://codesearch.test/:repository/structural-search", () =>
      HttpResponse.json({
        matches: [
          {
            file: `/cache/${seed.orgId}/${repositoryId}/checkouts/rev:${sha}/src/index.ts`,
            text: "charge(1)",
            range: {
              start: { line: 0, column: 0 },
              end: { line: 1, column: 9 },
            },
          },
        ],
      }),
    ),
    http.post("http://codesearch.test/:repository/graph", () =>
      HttpResponse.json({
        ok: true,
        results: [
          {
            symbol: "scip-typescript npm example 1 charge().",
            symbol_name: "charge",
            kind: "function",
            file_path: `/cache/${seed.orgId}/${repositoryId}/checkouts/rev:${sha}/src/charge.ts`,
            range: { start_line: 4, end_line: 6 },
          },
        ],
      }),
    ),
  )
  const structural = await callTool({
    name: "search_code",
    arguments: {
      org: seed.orgSlug,
      query: "charge($A)",
      mode: "structural",
      language: "typescript",
      excludeRepositories: [],
    },
  })
  expect(structural.isError).not.toBe(true)
  expect(structural.structuredContent?.files).toMatchObject([
    {
      ref: "example/alpha:src/index.ts",
      matches: [{ startLine: 1, endLine: 2 }],
    },
  ])
  const symbol = await callTool({
    name: "find_symbol",
    arguments: {
      org: seed.orgSlug,
      symbol: "charge",
      relation: "definition",
      excludeRepositories: [],
    },
  })
  expect(symbol.isError).not.toBe(true)
  expect(symbol.structuredContent?.results).toMatchObject([
    { ref: "example/alpha:src/charge.ts", startLine: 5, endLine: 7 },
  ])
})

it("drops one bad item into skipped instead of failing the call", async () => {
  server.use(
    http.post("http://codesearch.test/:repository/structural-search", () =>
      HttpResponse.json({
        matches: [
          {
            file: "/elsewhere/outside/the/checkout.ts",
            text: "bad",
            range: { start: { line: 0, column: 0 } },
          },
          {
            file: `/cache/${seed.orgId}/${repositoryId}/checkouts/default/src/index.ts`,
            text: "good",
            range: { start: { line: 0, column: 0 } },
          },
        ],
      }),
    ),
    http.post("http://codesearch.test/:repository/graph", () =>
      HttpResponse.json({
        ok: true,
        results: [
          { symbol: "no-name-or-kind" },
          {
            symbol: "scip-typescript npm example 1 charge().",
            symbol_name: "charge",
            kind: "function",
          },
        ],
      }),
    ),
  )
  const structural = await callTool({
    name: "search_code",
    arguments: {
      org: seed.orgSlug,
      query: "charge($A)",
      mode: "structural",
      language: "typescript",
      excludeRepositories: [],
    },
  })
  expect(structural.isError).not.toBe(true)
  expect(structural.structuredContent?.files).toMatchObject([
    { ref: "example/alpha:src/index.ts", matches: [{ snippet: "good" }] },
  ])
  expect(structural.structuredContent?.skipped).toContainEqual({
    repository: "example/alpha",
    reason: "failed",
  })
  const symbol = await callTool({
    name: "find_symbol",
    arguments: {
      org: seed.orgSlug,
      symbol: "charge",
      relation: "definition",
      excludeRepositories: [],
    },
  })
  expect(symbol.isError).not.toBe(true)
  expect(symbol.structuredContent?.results).toMatchObject([{ name: "charge" }])
  expect(symbol.structuredContent?.skipped).toContainEqual({
    repository: "example/alpha",
    reason: "failed",
  })
})

it("pages search_code and find_symbol with a cursor", async () => {
  server.use(
    http.post("http://codesearch.test/search", () =>
      HttpResponse.json({
        Result: {
          Files: Array.from({ length: 5 }, (_, index) => ({
            FileName: `src/file-${index}.ts`,
            RepositoryID: zoektRepoId,
            LineMatches: [
              {
                LineNumber: 1,
                Line: Buffer.from(`charge(${index})`).toString("base64"),
              },
            ],
          })),
        },
      }),
    ),
    http.post(
      "http://codesearch.test/:repository/graph",
      async ({ request }) => {
        const { limit } = (await request.json()) as { limit: number }
        return HttpResponse.json({
          ok: true,
          results: Array.from({ length: Math.min(5, limit) }, (_, index) => ({
            symbol: `scip charge${index}().`,
            symbol_name: `charge${index}`,
            kind: "function",
            file_path: `/cache/${seed.orgId}/${repositoryId}/checkouts/default/src/index.ts`,
            range: { start_line: index, end_line: index },
          })),
        })
      },
    ),
  )
  const walk = async (
    name: string,
    args: Record<string, unknown>,
    key: string,
  ) => {
    const seen: unknown[] = []
    let cursor: unknown
    for (let page = 0; page < 5; page++) {
      const result = await callTool({
        name,
        arguments: {
          org: seed.orgSlug,
          excludeRepositories: [],
          limit: 2,
          ...args,
          ...(cursor ? { cursor } : {}),
        },
      })
      expect(result.isError).not.toBe(true)
      const rows = (result.structuredContent?.results ??
        result.structuredContent?.files) as Array<Record<string, unknown>>
      seen.push(...rows.map((row) => row[key]))
      cursor = result.structuredContent?.cursor
      if (!cursor) break
    }
    return seen
  }
  expect(
    await walk("search_code", { query: "charge", mode: "literal" }, "ref"),
  ).toEqual(
    [0, 1, 2, 3, 4].map((index) => `example/alpha:src/file-${index}.ts`),
  )
  expect(
    await walk(
      "find_symbol",
      { symbol: "charge", relation: "definition" },
      "name",
    ),
  ).toEqual(["charge0", "charge1", "charge2", "charge3", "charge4"])

  const first = await callTool({
    name: "search_code",
    arguments: {
      org: seed.orgSlug,
      excludeRepositories: [],
      limit: 2,
      query: "charge",
      mode: "literal",
    },
  })
  const other = await callTool({
    name: "search_code",
    arguments: {
      org: seed.orgSlug,
      excludeRepositories: [],
      limit: 2,
      query: "different",
      mode: "literal",
      cursor: first.structuredContent?.cursor,
    },
  })
  expect(other._meta?.["ai.ctxpipe/error"]).toMatchObject({
    code: "invalid_cursor",
  })
})

it("keeps only the symbols of the language that find_symbol names", async () => {
  requests = []
  server.use(
    http.post(
      "http://codesearch.test/:repository/graph",
      async ({ request }) => {
        requests.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({
          ok: true,
          results: [
            {
              symbol: "scip-typescript npm example 1 charge().",
              symbol_name: "charge",
              kind: "function",
              file_path: `/cache/${seed.orgId}/${repositoryId}/checkouts/default/src/charge.ts`,
            },
            {
              symbol: "scip-python python example 1 charge().",
              symbol_name: "charge",
              kind: "function",
              file_path: `/cache/${seed.orgId}/${repositoryId}/checkouts/default/tools/charge.py`,
            },
            {
              symbol: "scip-python python example 1 refund().",
              symbol_name: "refund",
              kind: "function",
            },
          ],
        })
      },
    ),
  )
  const call = (language?: string) =>
    callTool({
      name: "find_symbol",
      arguments: {
        org: seed.orgSlug,
        symbol: "charge",
        relation: "definition",
        excludeRepositories: [],
        ...(language ? { language } : {}),
      },
    })
  const names = async (language?: string) =>
    (
      (await call(language)).structuredContent?.results as Array<{
        ref?: string
        name: string
      }>
    ).map((row) => row.ref ?? row.name)
  expect(await names("python")).toEqual([
    "example/alpha:tools/charge.py",
    "refund",
  ])
  expect(await names("TS")).toEqual(["example/alpha:src/charge.ts"])
  expect(await names()).toHaveLength(3)
  expect(requests.map((body) => body.limit)).toEqual([200, 200, 21])
  expect((await call("cobol"))._meta?.["ai.ctxpipe/error"]).toMatchObject({
    code: "invalid_argument",
  })
})

it("takes a search_code ref as the filePath of find_symbol", async () => {
  requests = []
  server.use(
    http.post(
      "http://codesearch.test/:repository/graph",
      async ({ request }) => {
        requests.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json({ ok: true, results: [] })
      },
    ),
  )
  const result = await callTool({
    name: "find_symbol",
    arguments: {
      org: seed.orgSlug,
      symbol: "charge",
      relation: "definition",
      excludeRepositories: [],
      filePath: "example/alpha:src/index.ts",
    },
  })
  expect(result.isError).not.toBe(true)
  expect(requests).toEqual([
    {
      primitive: "find_symbol",
      symbol: "charge",
      filePath: "src/index.ts",
      limit: 21,
    },
  ])
  expect(result.structuredContent?.skipped).toEqual([])
})

it("describes every input of the code tools", async () => {
  const { tools } = await client.listTools()
  for (const name of ["search_code", "find_symbol"]) {
    const properties = tools.find((tool) => tool.name === name)?.inputSchema
      .properties as Record<string, { description?: string }>
    for (const [key, schema] of Object.entries(properties)) {
      expect(schema.description, `${name}.${key}`).toBeTruthy()
    }
  }
})
